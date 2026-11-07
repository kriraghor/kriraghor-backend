"use strict";

/**
 * M27 round 3 request and response schemas (zod → validation and OpenAPI): staff shifts and clocking, pay
 * terms and payroll, the equipment register. Dates are Dhaka calendar dates; times ISO 8601; money in poisha;
 * rates in basis points (100 = 1%).
 */
const { z } = require("zod");
const rules = require("./gym-ops.rules");

const id = z.uuid();
const date = z.iso.date();
const dateTime = z.iso.datetime({ offset: true });
const nullable = (t) => t.nullable();
const text = (min, max) => z.string().trim().min(min).max(max);
const hhmm = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, "HH:MM, 24-hour, Dhaka time");
const period = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, "YYYY-MM");
const poisha = z.number().int().min(0);
const bps = z.number().int().min(0).max(10000);
const METHODS = rules.EXPENSE_METHODS;
const person = z.object({ id, displayName: nullable(z.string()) });
const staffRef = z.object({
  id: id.meta({ description: "The staff row (business member) id" }),
  userId: id,
  name: nullable(z.string()),
});

// ---------------- params and queries
const staffParam = z.object({ gymId: id, staffId: id });
const runParam = z.object({ gymId: id, runId: id });
const lineParam = z.object({ gymId: id, runId: id, lineId: id });
const assetParam = z.object({ gymId: id, assetId: id });
const boardQuery = z.object({ date: date.optional() });
const reportQuery = z.object({ period: period.optional() });
const timesQuery = z
  .object({ staffId: id, from: date, to: date })
  .refine((q) => q.from <= q.to && rules.daysBetween(q.from, q.to) <= 62, {
    message: "from on or before to, at most 62 days",
    path: ["from"],
  });
const assetQuery = z.object({
  status: z.enum(rules.ASSET_STATUSES).optional(),
});

// ---------------- bodies
const shift = z.object({
  dow: z
    .number()
    .int()
    .min(0)
    .max(6)
    .meta({ description: "0 = Sunday … 6 = Saturday" }),
  startTime: hhmm,
  endTime: hhmm,
});
const shiftsBody = z.object({ shifts: z.array(shift).max(42) });
const clockBody = z.object({
  staffId: id,
  kind: z.enum(["in", "out"]),
  note: nullable(text(1, 200)).optional(),
});
const scanBody = z.object({
  token: z
    .string()
    .min(10)
    .max(200)
    .meta({ description: "The entrance QR text (M24-FR-51)" }),
});
const payBody = z.object({
  basePoisha: poisha,
  ptCommissionBps: bps,
  salesCommissionBps: bps,
  note: nullable(text(1, 200)).optional(),
});
const runBody = z.object({ period });
const lineBody = z.object({
  bonusPoisha: poisha.optional(),
  deductionPoisha: poisha.optional(),
  note: nullable(text(1, 200)).optional(),
});
const payLineBody = z.object({
  method: z.enum(METHODS),
  paidOn: date.optional(),
  fromDrawer: z.boolean().optional(),
});
const voidBody = z.object({ reason: text(3, 300) });
const assetBody = z.object({
  name: text(1, 80),
  category: z.enum(rules.ASSET_CATEGORIES),
  brand: nullable(text(1, 60)).optional(),
  serial: nullable(text(1, 60)).optional(),
  location: nullable(text(1, 60)).optional(),
  boughtOn: nullable(date).optional(),
  costPoisha: nullable(poisha).optional(),
  status: z.enum(["working", "needs_service", "out_of_order"]).optional(),
  serviceEveryDays: nullable(z.number().int().min(1).max(3650)).optional(),
  lastServiceOn: nullable(date).optional(),
  note: nullable(text(1, 300)).optional(),
});
const assetPatch = assetBody
  .omit({ lastServiceOn: true, status: true })
  .partial()
  .extend({
    status: z.enum(rules.ASSET_STATUSES).optional(),
    statusNote: nullable(text(1, 300)).optional(),
  })
  .refine((b) => Object.keys(b).length > 0, { message: "Nothing to change" });
const assetLogBody = z.object({
  kind: z.enum(["service", "repair", "note"]),
  doneOn: date.optional(),
  costPoisha: nullable(z.number().int().min(1)).optional(),
  statusAfter: z.enum(["working", "needs_service", "out_of_order"]).optional(),
  note: nullable(text(1, 300)).optional(),
  expense: z
    .object({ method: z.enum(METHODS), fromDrawer: z.boolean().optional() })
    .optional()
    .meta({ description: "Record the cost as an equipment-repair expense" }),
});

// ---------------- responses
const ShiftView = z
  .object({ id, dow: z.number().int(), startTime: hhmm, endTime: hhmm })
  .meta({ id: "GymStaffShift" });
const StaffShifts = z
  .object({
    items: z.array(z.object({ staff: staffRef, shifts: z.array(ShiftView) })),
  })
  .meta({ id: "GymStaffShifts" });
const StaffShiftsOne = z
  .object({ staff: staffRef, shifts: z.array(ShiftView) })
  .meta({ id: "GymStaffShiftsOne" });
const TimeView = z
  .object({
    id,
    kind: z.enum(["in", "out"]),
    at: dateTime,
    localDate: date,
    method: z.enum(["desk", "entrance_qr", "auto"]),
    by: nullable(person),
    note: nullable(z.string()),
  })
  .meta({ id: "GymStaffTime" });
const Clocked = z
  .object({
    kind: z.enum(["in", "out"]),
    at: dateTime,
    method: z.enum(["desk", "entrance_qr"]),
    minutes: nullable(z.number().int()),
    gym: z.object({ id, name: z.string() }).optional(),
  })
  .meta({ id: "GymStaffClocked" });
const MyClock = z
  .object({
    gym: z.object({ id, name: z.string() }),
    clockedIn: z.boolean(),
    since: nullable(dateTime),
    todayShifts: z.array(ShiftView),
    monthMinutes: z.number().int(),
    today: z.array(TimeView),
  })
  .meta({ id: "GymMyClock" });
const Board = z
  .object({
    date,
    inNow: z.number().int(),
    items: z.array(
      z.object({
        staff: staffRef,
        clockedIn: z.boolean(),
        since: nullable(dateTime),
        shifts: z.array(ShiftView),
        times: z.array(TimeView),
        minutes: z.number().int(),
        late: z.boolean(),
      }),
    ),
  })
  .meta({ id: "GymStaffBoard" });
const StaffReport = z
  .object({
    period,
    items: z.array(
      z.object({
        staff: staffRef.extend({ status: z.enum(["active", "left"]) }),
        workedMinutes: z.number().int(),
        days: z.number().int(),
        late: z.number().int(),
        missed: z.number().int(),
      }),
    ),
  })
  .meta({ id: "GymStaffReport" });
const StaffTimes = z
  .object({ items: z.array(TimeView) })
  .meta({ id: "GymStaffTimes" });
const Terms = z
  .object({
    basePoisha: z.number().int(),
    ptCommissionBps: z.number().int(),
    salesCommissionBps: z.number().int(),
    note: nullable(z.string()),
    set: z.boolean(),
  })
  .meta({ id: "GymPayTermsValues" });
const PayTerms = z
  .object({
    limits: z.object({
      salaryMax: z.number().int(),
      commissionMax: z.number().int(),
    }),
    items: z.array(
      z.object({
        staff: staffRef.extend({ trainer: z.boolean(), seller: z.boolean() }),
        terms: Terms,
      }),
    ),
  })
  .meta({ id: "GymPayTerms" });
const PayTermsOne = z
  .object({ staff: staffRef, terms: Terms })
  .meta({ id: "GymPayTermsOne" });
const PayrollLine = z
  .object({
    id,
    staff: staffRef,
    basePoisha: z.number().int(),
    ptBasePoisha: z
      .number()
      .int()
      .meta({
        description:
          "Fees from the members assigned to this trainer in the month",
      }),
    ptCommissionBps: z.number().int(),
    ptCommissionPoisha: z.number().int(),
    salesBasePoisha: z
      .number()
      .int()
      .meta({ description: "Counter sales by this staff member in the month" }),
    salesCommissionBps: z.number().int(),
    salesCommissionPoisha: z.number().int(),
    bonusPoisha: z.number().int(),
    deductionPoisha: z.number().int(),
    netPoisha: z.number().int(),
    workedMinutes: z.number().int(),
    lateCount: z.number().int(),
    missedCount: z.number().int(),
    note: nullable(z.string()),
    status: z.enum(["unpaid", "paid"]),
    paidMethod: nullable(z.enum(METHODS)),
    paidOn: nullable(date),
  })
  .meta({ id: "GymPayrollLine" });
const RunSummary = z
  .object({
    id,
    period,
    status: z.enum(["draft", "approved", "paid", "void"]),
    staffCount: z.number().int(),
    totalNetPoisha: z.number().int(),
    paidPoisha: z.number().int(),
    approvedAt: nullable(dateTime),
    paidAt: nullable(dateTime),
    voidReason: nullable(z.string()),
    createdAt: dateTime,
  })
  .meta({ id: "GymPayrollRunSummary" });
const Runs = z
  .object({ items: z.array(RunSummary) })
  .meta({ id: "GymPayrollRuns" });
const Run = RunSummary.extend({ lines: z.array(PayrollLine) }).meta({
  id: "GymPayrollRun",
});
const Payslip = z
  .object({
    gym: z.object({ id, name: z.string(), address: nullable(z.string()) }),
    period,
    runStatus: z.enum(["draft", "approved", "paid", "void"]),
    line: PayrollLine,
  })
  .meta({ id: "GymPayslip" });
const MyPayslips = z
  .object({
    items: z.array(
      z.object({
        lineId: id,
        runId: id,
        period,
        netPoisha: z.number().int(),
        status: z.enum(["unpaid", "paid"]),
        paidOn: nullable(date),
      }),
    ),
  })
  .meta({ id: "GymMyPayslips" });
const Asset = z
  .object({
    id,
    name: z.string(),
    category: z.enum(rules.ASSET_CATEGORIES),
    brand: nullable(z.string()),
    serial: nullable(z.string()),
    location: nullable(z.string()),
    boughtOn: nullable(date),
    costPoisha: nullable(z.number().int()),
    status: z.enum(rules.ASSET_STATUSES),
    serviceEveryDays: nullable(z.number().int()),
    lastServiceOn: nullable(date),
    nextServiceOn: nullable(date),
    serviceDue: z.boolean(),
    note: nullable(z.string()),
  })
  .meta({ id: "GymAsset" });
const Assets = z
  .object({
    counts: z.object({
      working: z.number().int(),
      needs_service: z.number().int(),
      out_of_order: z.number().int(),
      retired: z.number().int(),
      serviceDue: z.number().int(),
    }),
    items: z.array(Asset),
  })
  .meta({ id: "GymAssets" });
const AssetLog = z
  .object({
    id,
    kind: z.enum(["service", "repair", "status", "note"]),
    doneOn: date,
    costPoisha: nullable(z.number().int()),
    statusAfter: nullable(z.enum(rules.ASSET_STATUSES)),
    note: nullable(z.string()),
    expenseId: nullable(id),
    by: person,
    createdAt: dateTime,
  })
  .meta({ id: "GymAssetLog" });
const AssetLogs = z
  .object({ asset: Asset, items: z.array(AssetLog) })
  .meta({ id: "GymAssetLogs" });

module.exports = {
  staffParam,
  runParam,
  lineParam,
  assetParam,
  boardQuery,
  reportQuery,
  timesQuery,
  assetQuery,
  shiftsBody,
  clockBody,
  scanBody,
  payBody,
  runBody,
  lineBody,
  payLineBody,
  voidBody,
  assetBody,
  assetPatch,
  assetLogBody,
  StaffShifts,
  StaffShiftsOne,
  Clocked,
  MyClock,
  Board,
  StaffReport,
  StaffTimes,
  PayTerms,
  PayTermsOne,
  Runs,
  Run,
  Payslip,
  MyPayslips,
  Asset,
  Assets,
  AssetLogs,
};
