'use strict';

/**
 * M27 routes, round 1. Every /manage/gyms/:gymId/** route passes authenticate and the gate work_gym; the
 * service resolves access through gym-manage (404 for anyone unrelated, 403 PERMISSION_REQUIRED for staff
 * without the permission, 403 GYM_TIER_REQUIRED below the plan). Idempotency-Key on every POST that records
 * money, a sale or stock (IK).
 *   manageRouter  /manage/gyms/:gymId   expense categories and expenses, the cash drawer, profit and loss,
 *                                       products and stock, counter sales and receipts, lockers and rentals;
 *                                       round 2: classes and sessions, points and rewards, notices, enquiries;
 *                                       round 3: staff shifts and clocking, pay terms and payroll, equipment
 *   meRouter      /me                   my class timetable, bookings and points (linked members); staff
 *                                       clock in and out by the entrance QR
 *   publicRouter  /gym                  the gym page timetable and the enquiry form (no sign-in)
 */
const { Router } = require('express');
const { validate } = require('../../common/validate');
const { requireIdempotencyKey } = require('../../common/idempotency');
const { authenticate, requireGate } = require('../../middlewares/auth');
const s = require('./gym-ops.schemas');
const expenses = require('./expenses.service');
const cash = require('./cash.service');
const pnl = require('./pnl.service');
const shop = require('./shop.service');
const lockers = require('./lockers.service');

const params = (schema) => validate(schema, 'params');
const query = (schema) => validate(schema, 'query');
const ik = (action) => requireIdempotencyKey(`gym_ops.${action}`);
const P = (req) => req.params.gymId;

const manageRouter = Router();
manageRouter.use(authenticate);
const g = Router({ mergeParams: true });
manageRouter.use('/gyms/:gymId', requireGate('work_gym'), params(s.gymParam), g);

// Expenses (M27-FR-01..05).
g.get('/expense-categories', async (req, res) => res.json(await expenses.categories(req.user, P(req))));
g.put('/expense-categories', validate(s.categoriesBody), async (req, res) => res.json(await expenses.saveCategories(req.user, P(req), req.body, req)));
g.get('/expenses', query(s.expenseQuery), async (req, res) => res.json(await expenses.list(req.user, P(req), req.validQuery)));
g.post('/expenses', validate(s.expenseBody), ik('expense'), async (req, res) => res.status(201).json(await expenses.create(req.user, P(req), req.body, req)));
g.post('/expenses/:expenseId/void', params(s.expenseParam), validate(s.reasonBody), async (req, res) => res.json(await expenses.voidOne(req.user, P(req), req.params.expenseId, req.body, req)));

// The cash drawer (M27-FR-06..09) and profit and loss (M27-FR-27).
g.get('/cash-drawer', query(s.dayQuery), async (req, res) => res.json(await cash.get(req.user, P(req), req.validQuery)));
g.post('/cash-drawer/open', validate(s.openBody), async (req, res) => res.status(201).json(await cash.open(req.user, P(req), req.body, req)));
g.post('/cash-drawer/close', validate(s.closeBody), async (req, res) => res.json(await cash.close(req.user, P(req), req.body, req)));
g.get('/pnl', query(s.periodQuery), async (req, res) => res.json(await pnl.get(req.user, P(req), req.validQuery)));

// The counter shop (M27-FR-10..21).
g.get('/products', query(s.productQuery), async (req, res) => res.json(await shop.products(req.user, P(req), req.validQuery)));
g.post('/products', validate(s.productBody), async (req, res) => res.status(201).json(await shop.createProduct(req.user, P(req), req.body, req)));
g.patch('/products/:productId', params(s.productParam), validate(s.productPatch), async (req, res) => res.json(await shop.updateProduct(req.user, P(req), req.params.productId, req.body, req)));
g.post('/products/:productId/stock', params(s.productParam), validate(s.stockBody), ik('stock'), async (req, res) => res.status(201).json(await shop.stock(req.user, P(req), req.params.productId, req.body, req)));
g.get('/sales', query(s.saleQuery), async (req, res) => res.json(await shop.sales(req.user, P(req), req.validQuery)));
g.post('/sales', validate(s.saleBody), ik('sale'), async (req, res) => res.status(201).json(await shop.sell(req.user, P(req), req.body, req)));
g.get('/sales/:saleId/receipt', params(s.saleParam), async (req, res) => res.json(await shop.receipt(req.user, P(req), req.params.saleId)));
g.post('/sales/:saleId/reverse', params(s.saleParam), validate(s.reasonBody), async (req, res) => res.json(await shop.reverse(req.user, P(req), req.params.saleId, req.body, req)));

// Lockers (M27-FR-22..26).
g.get('/lockers', async (req, res) => res.json(await lockers.grid(req.user, P(req))));
g.post('/lockers', validate(s.lockerBody), async (req, res) => res.status(201).json(await lockers.add(req.user, P(req), req.body, req)));
g.patch('/lockers/:lockerId', params(s.lockerParam), validate(s.lockerPatch), async (req, res) => res.json(await lockers.update(req.user, P(req), req.params.lockerId, req.body, req)));
g.post('/lockers/:lockerId/rent', params(s.lockerParam), validate(s.rentBody), ik('locker_rent'), async (req, res) => res.status(201).json(await lockers.rent(req.user, P(req), req.params.lockerId, req.body, req)));
g.get('/locker-rentals', query(s.rentalQuery), async (req, res) => res.json(await lockers.rentals(req.user, P(req), req.validQuery)));
g.post('/locker-rentals/:rentalId/collect', params(s.rentalParam), validate(s.collectBody), ik('locker_fee'), async (req, res) => res.status(201).json(await lockers.collect(req.user, P(req), req.params.rentalId, req.body, req)));
g.post('/locker-rentals/:rentalId/end', params(s.rentalParam), validate(s.reasonBody), async (req, res) => res.json(await lockers.end(req.user, P(req), req.params.rentalId, req.body, req)));

// ---------------------------------------------------------------- round 2
const r2 = require('./gym-ops-round2.schemas');
const classes = require('./classes.service');
const points = require('./points.service');
const notices = require('./notices.service');
const leads = require('./leads.service');
const conversion = require('./conversion.service');
const r3 = require('./gym-ops-round3.schemas');
const staff = require('./staff.service');
const payroll = require('./payroll.service');
const assets = require('./assets.service');

// Classes (M27-FR-45..54).
g.get('/class-trainers', async (req, res) => res.json(await classes.trainers(req.user, P(req))));
g.get('/classes', query(r2.classQuery), async (req, res) => res.json(await classes.list(req.user, P(req), req.validQuery)));
g.post('/classes', validate(r2.classBody), async (req, res) => res.status(201).json(await classes.create(req.user, P(req), req.body, req)));
g.patch('/classes/:classId', params(r2.classParam), validate(r2.classPatch), async (req, res) => res.json(await classes.update(req.user, P(req), req.params.classId, req.body, req)));
g.put('/classes/:classId/slots', params(r2.classParam), validate(r2.slotsBody), async (req, res) => res.json(await classes.setSlots(req.user, P(req), req.params.classId, req.body, req)));
g.get('/class-sessions', query(r2.sessionQuery), async (req, res) => res.json(await classes.sessions(req.user, P(req), req.validQuery)));
g.get('/class-sessions/:sessionId', params(r2.sessionParam), async (req, res) => res.json(await classes.session(req.user, P(req), req.params.sessionId)));
g.post('/class-sessions/:sessionId/cancel', params(r2.sessionParam), validate(r2.reasonBody), async (req, res) => res.json(await classes.cancelSession(req.user, P(req), req.params.sessionId, req.body, req)));
g.post('/class-sessions/:sessionId/bookings', params(r2.sessionParam), validate(r2.bookBody), ik('class_booking'), async (req, res) => res.status(201).json(await classes.deskBook(req.user, P(req), req.params.sessionId, req.body, req)));
g.post('/class-sessions/:sessionId/attendance', params(r2.sessionParam), validate(r2.attendanceBody), async (req, res) => res.json(await classes.markAttendance(req.user, P(req), req.params.sessionId, req.body, req)));
g.post('/class-bookings/:bookingId/cancel', params(r2.bookingParam), async (req, res) => res.json(await classes.deskCancel(req.user, P(req), req.params.bookingId, req)));

// Points and rewards (M27-FR-55..61).
g.get('/rewards', async (req, res) => res.json(await points.rewards(req.user, P(req))));
g.put('/rewards', validate(r2.rewardsBody), async (req, res) => res.json(await points.saveRewards(req.user, P(req), req.body, req)));
g.get('/members/:memberId/points', params(r2.memberParam), async (req, res) => res.json(await points.memberPoints(req.user, P(req), req.params.memberId)));
g.post('/members/:memberId/redeem', params(r2.memberParam), validate(r2.redeemBody), ik('points_redeem'), async (req, res) => res.status(201).json(await points.redeem(req.user, P(req), req.params.memberId, req.body, req)));
g.post('/members/:memberId/points/adjust', params(r2.memberParam), validate(r2.adjustBody), async (req, res) => res.json(await points.adjust(req.user, P(req), req.params.memberId, req.body, req)));
g.post('/members/:memberId/referral', params(r2.memberParam), validate(r2.referralBody), async (req, res) => res.json(await points.setReferral(req.user, P(req), req.params.memberId, req.body, req)));

// Notices (M27-FR-62..65).
g.get('/notices', async (req, res) => res.json(await notices.list(req.user, P(req))));
g.post('/notices/estimate', validate(r2.estimateBody), async (req, res) => res.json(await notices.estimate(req.user, P(req), req.body)));
g.post('/notices', validate(r2.noticeBody), ik('notice'), async (req, res) => res.status(201).json(await notices.send(req.user, P(req), req.body, req)));

// Enquiries (M27-FR-66..69).
// M27-FR-87 to FR-91: where members come from (enquiries, trial visits, join requests), and its CSV for the owner.
g.get('/reports/conversion', query(r2.conversionQuery), async (req, res) => res.json(await conversion.get(req.user, P(req), req.validQuery)));
g.get('/reports/conversion/export', query(r2.conversionQuery), async (req, res) => {
  const file = await conversion.exportCsv(req.user, P(req), req.validQuery, req);
  res.set('Content-Type', 'text/csv; charset=utf-8').set('Content-Disposition', `attachment; filename="${file.filename}"`).set('Cache-Control', 'no-store').send(file.body);
});
g.get('/leads', query(r2.leadQuery), async (req, res) => res.json(await leads.list(req.user, P(req), req.validQuery)));
g.patch('/leads/:leadId', params(r2.leadParam), validate(r2.leadPatch), async (req, res) => res.json(await leads.update(req.user, P(req), req.params.leadId, req.body, req)));
g.post('/leads/:leadId/reveal-phone', params(r2.leadParam), async (req, res) => res.set('Cache-Control', 'no-store').json(await leads.revealPhone(req.user, P(req), req.params.leadId, req)));

// ---------------------------------------------------------------- round 3

// Staff attendance (M27-FR-72..75).
g.get('/staff-shifts', async (req, res) => res.json(await staff.shifts(req.user, P(req))));
g.put('/staff/:staffId/shifts', params(r3.staffParam), validate(r3.shiftsBody), async (req, res) => res.json(await staff.setShifts(req.user, P(req), req.params.staffId, req.body, req)));
g.get('/staff-attendance', query(r3.boardQuery), async (req, res) => res.json(await staff.board(req.user, P(req), req.validQuery)));
g.get('/staff-report', query(r3.reportQuery), async (req, res) => res.json(await staff.report(req.user, P(req), req.validQuery)));
g.get('/staff-times', query(r3.timesQuery), async (req, res) => res.json(await staff.times(req.user, P(req), req.validQuery)));
g.post('/staff-times', validate(r3.clockBody), async (req, res) => res.status(201).json(await staff.clockAtDesk(req.user, P(req), req.body, req)));
g.get('/staff-clock/me', async (req, res) => res.json(await staff.myClock(req.user, P(req))));

// Payroll (M27-FR-76..81; Pro; the owner, and each staff member's own payslips).
g.get('/staff-pay', async (req, res) => res.json(await payroll.payTerms(req.user, P(req))));
g.put('/staff/:staffId/pay', params(r3.staffParam), validate(r3.payBody), async (req, res) => res.json(await payroll.setPayTerms(req.user, P(req), req.params.staffId, req.body, req)));
g.get('/payroll', async (req, res) => res.json(await payroll.runs(req.user, P(req))));
g.post('/payroll', validate(r3.runBody), async (req, res) => res.status(201).json(await payroll.create(req.user, P(req), req.body, req)));
g.get('/payroll/:runId', params(r3.runParam), async (req, res) => res.json(await payroll.run(req.user, P(req), req.params.runId)));
g.post('/payroll/:runId/recalculate', params(r3.runParam), async (req, res) => res.json(await payroll.recalculate(req.user, P(req), req.params.runId, req)));
g.post('/payroll/:runId/approve', params(r3.runParam), async (req, res) => res.json(await payroll.approve(req.user, P(req), req.params.runId, req)));
g.post('/payroll/:runId/void', params(r3.runParam), validate(r3.voidBody), async (req, res) => res.json(await payroll.voidRun(req.user, P(req), req.params.runId, req.body, req)));
g.patch('/payroll/:runId/lines/:lineId', params(r3.lineParam), validate(r3.lineBody), async (req, res) => res.json(await payroll.updateLine(req.user, P(req), req.params.runId, req.params.lineId, req.body, req)));
g.post('/payroll/:runId/lines/:lineId/pay', params(r3.lineParam), validate(r3.payLineBody), ik('payroll_pay'), async (req, res) => res.json(await payroll.payLine(req.user, P(req), req.params.runId, req.params.lineId, req.body, req)));
g.get('/payroll/:runId/lines/:lineId/payslip', params(r3.lineParam), async (req, res) => res.set('Cache-Control', 'no-store').json(await payroll.payslip(req.user, P(req), req.params.runId, req.params.lineId)));
g.get('/my-payslips', async (req, res) => res.set('Cache-Control', 'no-store').json(await payroll.myPayslips(req.user, P(req))));

// The equipment register (M27-FR-82..86).
g.get('/assets', query(r3.assetQuery), async (req, res) => res.json(await assets.list(req.user, P(req), req.validQuery)));
g.post('/assets', validate(r3.assetBody), async (req, res) => res.status(201).json(await assets.create(req.user, P(req), req.body, req)));
g.patch('/assets/:assetId', params(r3.assetParam), validate(r3.assetPatch), async (req, res) => res.json(await assets.update(req.user, P(req), req.params.assetId, req.body, req)));
g.get('/assets/:assetId/logs', params(r3.assetParam), async (req, res) => res.json(await assets.logs(req.user, P(req), req.params.assetId)));
g.post('/assets/:assetId/logs', params(r3.assetParam), validate(r3.assetLogBody), ik('asset_log'), async (req, res) => res.status(201).json(await assets.addLog(req.user, P(req), req.params.assetId, req.body, req)));

// The member (linked account): classes and points.
// authenticate per route: other modules' /me routes pass through this router.
const meRouter = Router();
meRouter.get('/gym-classes', authenticate, query(r2.myQuery), async (req, res) => res.json(await classes.myTimetable(req.user, req.validQuery)));
meRouter.post('/gym-classes/:sessionId/book', authenticate, params(r2.mySessionParam), validate(r2.bookBody), ik('my_class_booking'), async (req, res) => res.status(201).json(await classes.myBook(req.user, req.params.sessionId, req.body, req)));
meRouter.get('/gym-bookings', authenticate, query(r2.myMemberQuery), async (req, res) => res.json(await classes.myBookings(req.user, req.validQuery)));
meRouter.post('/gym-bookings/:bookingId/cancel', authenticate, params(r2.myBookingParam), async (req, res) => res.json(await classes.myCancel(req.user, req.params.bookingId, req)));
meRouter.get('/gym-points', authenticate, query(r2.myMemberQuery), async (req, res) => res.json(await points.mine(req.user, req.validQuery)));
// M27-FR-73: a staff member clocks in or out by scanning the gym's entrance QR.
meRouter.post('/gym-staff-clock', authenticate, validate(r3.scanBody), async (req, res) => res.status(201).json(await staff.clockByScan(req.user, req.body, req)));

// Public (the gym page): the week's timetable and the enquiry form.
const publicRouter = Router();
publicRouter.get('/gyms/:slug/timetable', params(r2.slugParam), async (req, res) => res.set('Cache-Control', 'public, max-age=60').json(await classes.publicTimetable(req.params.slug)));
publicRouter.post('/gyms/:slug/enquiries', params(r2.slugParam), validate(r2.enquiryBody), async (req, res) => res.status(202).json(await leads.enquire(req.params.slug, req.body, req)));

module.exports = { manageRouter, meRouter, publicRouter };
