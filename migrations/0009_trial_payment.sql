-- A salon that pays during its trial authorises the Razorpay mandate (subscription.authenticated) but is only charged when the trial ends.
-- These columns let the portal show "payment method set up, first charge on <date>" while status is still trialing.
ALTER TABLE subscriptions ADD COLUMN payment_authorized_at timestamptz;
ALTER TABLE subscriptions ADD COLUMN next_charge_at timestamptz;
