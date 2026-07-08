-- Seed data for carrier_senders (ProducerStack carrier-sender-and-type map)
-- Generated from real inbox discovery on 2026-07-08.
-- Matching rules the application code must implement:
--   1. Lowercase the From address before matching from_pattern (ILIKE, '%' wildcard).
--   2. If multiple rows match the address, evaluate subject_pattern (case-insensitive regex)
--      in ascending `priority` order; first hit wins.
--   3. A row with subject_pattern = NULL matches any subject (use as the sender's default).
--   4. No matching row but domain is a known carrier domain => classify 'unclassified', send to review queue.

insert into carrier_senders
  (carrier, from_pattern, subject_pattern, email_type, content_type, route, priority, notes) values

-- ============ MUTUAL OF OMAHA ============
('mutual_of_omaha', 'do_not_reply_igo_eapp@mutualofomaha.com', null,
 'application_activity', 'body', 'policy_tracker', 10,
 'New e-app submitted; policy # in subject and body.'),
('mutual_of_omaha', 'noreply.login@login.mutualofomaha.com', null,
 'ignore', 'body', 'ignore', 10, 'One-time login codes.'),
('mutual_of_omaha', 'contractsandappointments@mutualofomaha.com', null,
 'ignore', 'pdf', 'ignore', 10, 'Contracting forms.'),
('mutual_of_omaha', 'mutualofomaha@secure.mutualofomaha.com', null,
 'ignore', 'body', 'ignore', 10, 'Account setup.'),
('mutual_of_omaha', 'mutualofomaha@e.mutualofomaha.com', null,
 'ignore', 'body', 'ignore', 10, 'Contracting docs.'),
-- Personal underwriter addresses vary per case: domain-wide catch with subject filter. Low priority so specific rows above win.
('mutual_of_omaha', '%@mutualofomaha.com', '^(App Review|Withdrawn|Phone Interview|Approved|Declined)',
 'underwriting_status', 'body', 'policy_tracker', 50,
 'Personal underwriter senders (e.g. aubrey.street-mccarthy@). Body: File Number, Insured, Plan, Face Amount.'),

-- ============ TRANSAMERICA ============
('transamerica', 'mocasemanagement@transamerica.com', null,
 'underwriting_status', 'body', 'policy_tracker', 10,
 'Requirements / approvals / closures. POLICY # MASKED as xxxxx76911 -> last-5 matching. Occasional PDF attachments.'),
('transamerica', 'newbusinesstlp@transamerica.com', null,
 'application_activity', 'body', 'policy_tracker', 10, 'Application received.'),
('transamerica', 'notifications@mylifeinsurance.transamerica.com', 'Application Results',
 'underwriting_status', 'body', 'policy_tracker', 10,
 'FE Express instant decisions (mostly declines, reason in body).'),
('transamerica', 'notifications@mylifeinsurance.transamerica.com', '(Payment Scheduled|Policy Purchase Is Processing|Incomplete Purchase)',
 'payment_result', 'body', 'policy_tracker', 20,
 'Payment lifecycle. May be To: client, agent cc''d -> parse client from body, not headers.'),
('transamerica', 'notifications@mylifeinsurance.transamerica.com', '(Your Policy Documents Are Ready|Your Application Is Ready to Review)',
 'policy_active', 'body', 'policy_tracker', 30, 'Policy in force / docs ready.'),
('transamerica', 'tlp-crcontractadmin@transamerica.com', null,
 'commission_change', 'body', 'commission_summary', 10,
 'ZSecure contracting/commission-level changes; data in body, commission schedule PDF attached.'),
('transamerica', 'transamericacxinsights@transamerica.com', null, 'ignore', 'body', 'ignore', 10, 'Surveys.'),
('transamerica', 'webhelp@transamerica.com', null, 'ignore', 'body', 'ignore', 10, 'Login codes.'),
('transamerica', 'awdemailnotification@transamerica.com', null, 'ignore', 'body', 'ignore', 10, 'Auto-replies.'),
('transamerica', '%@sales.transamerica.com', null, 'ignore', 'body', 'ignore', 10, 'Sales-rep marketing (personal addresses on the sales subdomain).'),
('transamerica', 'noreply@email.transamerica.com', null, 'ignore', 'body', 'ignore', 10, 'Bulk agent-update notices; no per-client data.'),

-- ============ COREBRIDGE ============
('corebridge', 'sigiteam@corebridgefinancial.com', null,
 'payment_result', 'body', 'policy_tracker', 10,
 'SIWL/GIWL new business: returned payments, reissue, beneficiary. Policy # + client in subject/body.'),
('corebridge', 'svc_ilcc_prod@corebridgefinancial.com', null,
 'portal_notification', 'login_link', 'nudge', 10,
 'Cisco Secure Message: NO data in email. Never fetch the link.'),
('corebridge', 'donotreply@corebridgefinancial.com', null, 'ignore', 'body', 'ignore', 10, 'Activation codes.'),
('corebridge', 'customerexperience@feedback.corebridgefinancial.com', null, 'ignore', 'body', 'ignore', 10, 'Surveys.'),

-- ============ AMERICO ============
-- NOTE: noreply@ and donotreply@ differ; Daily Update vs portal notification split is by sender AND subject.
('americo', 'noreply@americo.com', '^Americo Daily Update',
 'commission_summary', 'body', 'commission_summary', 10,
 'Daily digest: commission summary/balance, pending counts, issued-not-paid + lapse-pending COUNTS. Lapse count > 0 should also flag policy_tracker.'),
('americo', 'donotreply@americo.com', 'New Notification Regarding',
 'portal_notification', 'login_link', 'nudge', 10,
 'Per-client portal notification. Regex-capture client name + link label (e.g. "Adverse Decision") for nudge text; details need portal login.'),
('americo', 'noreply.collections@americo.com', null,
 'commission_change', 'body', 'commission_summary', 10, 'Agent debt/chargeback balance.'),
('americo', 'americo.marketing@americo.com', null, 'ignore', 'body', 'ignore', 10, 'Marketing.'),
('americo', 'lindsay.autry@americo.com', null, 'ignore', 'body', 'ignore', 10, 'Marketing (personal).'),
('americo', 'andrew.kostus@americo.com', null, 'ignore', 'body', 'ignore', 10, 'Marketing (personal).'),
('americo', 'brandon.wilson@americo.com', null, 'ignore', 'body', 'ignore', 10, 'Marketing (personal).'),

-- ============ AMERICAN-AMICABLE ============
-- Same address, two types (arrives as NOREPLY@ and noreply@ — match case-insensitively, split on subject).
('american_amicable', 'noreply@aatx.com', '^APPLICATION ACTIVITY',
 'application_activity', 'body', 'policy_tracker', 10,
 'Daily status digest: SUBMITTED/ISSUED/DECLINED/WITHDRAWN with policy # + client. Can contain MULTIPLE policies per email -> parser returns array.'),
('american_amicable', 'noreply@aatx.com', '^Returned Payment',
 'payment_result', 'body', 'policy_tracker', 20,
 'Payment not honored: policy #, client, amount, reason.'),
('american_amicable', 'noreply@aatx.com', '^Policyholder Correspondence',
 'policyholder_correspondence', 'body', 'policy_tracker', 25,
 'Coded correspondence in body (e.g. "Doc: ABDI2 BK DRFT RTN NSF W/AGT INFO"). Parser deciphers shorthand. Covers American Amicable + Occidental Life.'),
('american_amicable', 'noreply@aatx.com', '(Login Code|Verification Code)',
 'ignore', 'body', 'ignore', 30,
 'Agent portal login/verification codes.'),
('american_amicable', 'marketingassistants@americanamicable.com', null, 'ignore', 'body', 'ignore', 10, 'Welcome/admin.'),
('american_amicable', '%@american-amicablegroup.ccsend.com', null, 'ignore', 'body', 'ignore', 10, 'Constant Contact marketing.'),

-- ============ ETHOS ============
-- Portal-first carrier: one sender mixes marketing + transactional. Allowlist subjects; default ignore.
('ethos', 'ethosforagent@mail.ethos-agents.com', '(complete their insurance application|application is almost done)',
 'application_activity', 'body', 'policy_tracker', 10,
 'Incomplete-application nudges, client name in subject/body.'),
('ethos', 'ethosforagent@mail.ethos-agents.com', 'compensation',
 'commission_change', 'body', 'commission_summary', 20,
 'Compensation processing/delay notices; no per-policy data.'),
('ethos', 'ethosforagent@mail.ethos-agents.com', null,
 'ignore', 'body', 'ignore', 90, 'DEFAULT for this sender: marketing.'),
('ethos', 'agents@ethoslife.com', null, 'ignore', 'body', 'ignore', 10, 'Login codes / device trusted.');
