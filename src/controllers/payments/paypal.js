var nconf = require('nconf');
var moment = require('moment');
var async = require('async');
var _ = require('lodash');
var url = require('url');
var mongoose = require('mongoose');
var payments = require('./../payments');
var logger = require('../../logging');
var ipn = require('paypal-ipn');
var paypal = require('paypal-rest-sdk');

paypal.configure({
  'mode': nconf.get("PAYPAL:mode"), //sandbox or live
  'client_id': nconf.get("PAYPAL:client_id"),
  'client_secret': nconf.get("PAYPAL:client_secret")
});

var parseErr = function(err){
  return (err.response && err.response.message || err.response.details[0].issue) || err;
}

// Initialize Billing Plans
var billingPlanID;
var billingPlanTitle ="HabitRPG subscription ($5 month-to-month)";
(function(){
  var billingPlanAttributes = {
    // https://developer.paypal.com/docs/api/#billing-plans-and-agreements
    "name": billingPlanTitle,
    "description": billingPlanTitle,
    "type": "INFINITE",
    "merchant_preferences": {
      "auto_bill_amount": "yes",
      "cancel_url": nconf.get("BASE_URL"),
      "return_url": nconf.get('BASE_URL') + '/paypal/subscribe/success'
    },
    "payment_definitions": [{
      "name": billingPlanTitle,
      "type": "REGULAR",
      "frequency_interval": "1",
      "frequency": "MONTH",
      "cycles": "0",
      "amount": {
        "currency": "USD",
        "value": "5"
      }
    }]
  };

  async.waterfall([
    function(cb) {
      paypal.billingPlan.list({status: 'ACTIVE'}, cb);
    },
    function(plans, cb){
      var plan = _.find(plans.plans, {name:billingPlanTitle});
      if (plan) return cb(null, plan);
      paypal.billingPlan.create(billingPlanAttributes, cb);
    },
    function(plan, cb){
      if (plan.state == "ACTIVE") return cb(null, plan);
      // Super obvious this stuff, right? *sigh*
      var billingPlanUpdateAttributes = [{
        "op": "replace",
        "path": "/",
        "value": {
          "state": "ACTIVE"
        }
      }];
      // Activate the plan by changing status to Active
      paypal.billingPlan.update(plan.id, billingPlanUpdateAttributes, function(err, response){
        if (err) return cb(err);
        cb(null, plan);
      });
    },
  ],function(err, plan){
    billingPlanID = plan.id;
  })
})();

exports.createBillingAgreement = function(req,res,next){
  var billingAgreementAttributes = {
    "name": billingPlanTitle,
    "description": billingPlanTitle,
    "start_date": moment().add({minutes:1}).format(),
    "plan": {
      "id": billingPlanID
    },
    "payer": {
      "payment_method": "paypal"
    }
  };
  paypal.billingAgreement.create(billingAgreementAttributes, function (err, billingAgreement) {
    if (err) return next(parseErr(err));
    // For approving subscription via Paypal, first redirect user to: approval_url
    var approval_url = _.find(billingAgreement.links, {rel:'approval_url'}).href;
    res.redirect(approval_url);
  });
}

exports.executeBillingAgreement = function(req,res,next){
  async.waterfall([
    function(cb){
      paypal.billingAgreement.execute(req.query.token, {}, cb);
    },
    function(billingAgreement, cb){
      mongoose.model('User').findById(req.session.userId, function(err, user){
        if (err) return cb(err);
        cb(null, {billingAgreement:billingAgreement, user:user});
      });
    },
    function(data, cb){
      payments.createSubscription(data.user, {customerId: data.billingAgreement.id, paymentMethod: 'Paypal'});
      data.user.save(cb);
    }
  ],function(err){
    if (err) return next(parseErr(err));
    res.redirect('/');
  })
}

exports.createPayment = function(req, res, next) {
  var create_payment = {
    "intent": "sale",
    "payer": {
      "payment_method": "paypal"
    },
    "redirect_urls": {
      "return_url": nconf.get('BASE_URL') + '/paypal/checkout/success',
      "cancel_url": nconf.get('BASE_URL')
    },
    "transactions": [{
      "item_list": {
        "items": [{
          "name": "HabitRPG Gems",
          //"sku": "1",
          "price": "5.00",
          "currency": "USD",
          "quantity": 1
        }]
      },
      "amount": {
        "currency": "USD",
        "total": "5.00"
      },
      "description": "HabitRPG Gems"
    }]
  };
  paypal.payment.create(create_payment, function (err, payment) {
    if (err) return next(parseErr(err));
    var link = _.find(payment.links, {rel: 'approval_url'}).href;
    res.redirect(link);
  });
}

exports.executePayment = function(req, res, next) {
  var paymentId = req.query.paymentId,
    PayerID = req.query.PayerID;
  async.waterfall([
    function(cb){
      paypal.payment.execute(paymentId, {payer_id: PayerID}, cb);
    },
    function(payment, cb){
      mongoose.model('User').findById(req.session.userId, cb);
    },
    function(user, cb){
      if (_.isEmpty(user)) return cb("user not found when completing paypal transaction");
      payments.buyGems(user, {customerId:PayerID, paymentMethod:'Paypal'});
      user.save(cb);
    }
  ],function(err, saved){
    if (err) return next(parseErr(err));
    res.redirect('/');
  })
}

exports.cancelSubscription = function(req, res, next){
  var user = res.locals.user;
  if (!user.purchased.plan.customerId)
    return res.json(401, {err: "User does not have a plan subscription"});
  async.waterfall([
    function(cb) {
      paypal.billingAgreement.cancel(user.purchased.plan.customerId, {note: "Canceling the subscription"}, cb);
    },
    function(response, cb) {
      payments.cancelSubscription(user);
      user.save(cb);
    }
  ], function(err, saved){
    if (err) return next(parseErr(err));
    res.redirect('/');
    user = null;
  });
}

/**
 * General IPN handler. We catch cancelled HabitRPG subscriptions for users who manually cancel their
 * recurring paypal payments in their paypal dashboard. Remove this when we can move to webhooks or some other solution
 */
exports.ipn = function(req, res, next) {
  console.log('IPN Called');
  res.send(200); // Must respond to PayPal IPN request with an empty 200 first
  ipn.verify(req.body, function(err, msg) {
    if (err) return logger.error(msg);
    switch (req.body.txn_type) {
      // TODO what's the diff b/w the two data.txn_types below? The docs recommend subscr_cancel, but I'm getting the other one instead...
      case 'recurring_payment_profile_cancel':
      case 'subscr_cancel':
        mongoose.model('User').findOne({'purchased.plan.customerId':req.body.recurring_payment_id},function(err, user){
          if (err) return logger.error(err);
          if (_.isEmpty(user)) return; // looks like the cancellation was already handled properly above (see api.paypalSubscribeCancel)
          payments.cancelSubscription(user);
          user.save();
        });
        break;
    }
  });
};

