'use strict';

/**
 * M27 request and response schemas (zod → validation and OpenAPI). Money in poisha; dates are Dhaka
 * calendar dates (YYYY-MM-DD); times ISO 8601.
 */
const { z } = require('zod');
const rules = require('./gym-ops.rules');

const id = z.uuid();
const date = z.iso.date();
const dateTime = z.iso.datetime({ offset: true });
const poisha = z.number().int();
const nullable = (t) => t.nullable();
const text = (min, max) => z.string().trim().min(min).max(max);
const limit = z.coerce.number().int().min(1).max(100).default(25);

// ---------------- params and queries
const gymParam = z.object({ gymId: id });
const expenseParam = z.object({ gymId: id, expenseId: id });
const productParam = z.object({ gymId: id, productId: id });
const saleParam = z.object({ gymId: id, saleId: id });
const lockerParam = z.object({ gymId: id, lockerId: id });
const rentalParam = z.object({ gymId: id, rentalId: id });
const periodQuery = z
  .object({ from: date.optional(), to: date.optional() })
  .refine((q) => !q.from || !q.to || q.from <= q.to, { message: 'from must be on or before to', path: ['from'] });
const expenseQuery = z.object({ from: date.optional(), to: date.optional(), categoryId: id.optional(), status: z.enum(['recorded', 'void']).optional(), cursor: z.string().max(200).optional(), limit });
const dayQuery = z.object({ date: date.optional() });
const productQuery = z.object({ q: text(1, 80).optional(), barcode: text(1, 40).optional(), status: z.enum(['active', 'retired']).optional(), low: z.enum(['true', 'false']).optional() });
const saleQuery = z.object({ date: date.optional(), cursor: z.string().max(200).optional(), limit });
const rentalQuery = z.object({ memberId: id.optional(), status: z.enum(['active', 'ended', 'cancelled']).optional() });

// ---------------- bodies
const categoriesBody = z.object({
  categories: z
    .array(z.object({ id: id.optional(), name: text(1, 60), status: z.enum(['active', 'retired']).default('active') }))
    .min(1)
    .max(40),
});
const expenseBody = z.object({
  categoryId: id,
  amountPoisha: poisha.positive(),
  spentOn: date.optional().meta({ description: 'Default today; up to gym_manage.backdate_days back' }),
  method: z.enum(rules.EXPENSE_METHODS),
  fromDrawer: z.boolean().default(false).meta({ description: 'Paid in cash from today’s drawer (method cash only)' }),
  payee: nullable(text(1, 80)).optional(),
  note: nullable(text(1, 300)).optional(),
});
const reasonBody = z.object({ reason: text(3, 300) });
const openBody = z.object({ openingPoisha: poisha.min(0) });
const closeBody = z.object({ countedPoisha: poisha.min(0), note: nullable(text(1, 300)).optional() });
const productBody = z.object({
  name: text(2, 80),
  barcode: nullable(text(3, 40)).optional(),
  category: z.enum(rules.PRODUCT_CATEGORIES),
  pricePoisha: poisha.positive(),
  costPoisha: nullable(poisha.min(0)).optional(),
  reorderLevel: z.number().int().min(0).max(100000).default(0),
  batchNo: nullable(text(1, 40)).optional(),
  expiresOn: nullable(date).optional(),
  importer: nullable(text(1, 120)).optional().meta({ description: 'Importer or BSTI details (supplements)' }),
});
const productPatch = productBody.partial().extend({ status: z.enum(['active', 'retired']).optional() }).refine((b) => Object.keys(b).length > 0, 'Nothing to change');
const stockBody = z.object({
  kind: z.enum(['in', 'adjust', 'write_off']),
  qty: z.number().int().refine((n) => n !== 0, 'Not zero').meta({ description: 'in: more than 0; write_off: more than 0 (taken away); adjust: + or −' }),
  unitCostPoisha: nullable(poisha.min(0)).optional(),
  batchNo: nullable(text(1, 40)).optional(),
  expiresOn: nullable(date).optional(),
  note: nullable(text(1, 200)).optional(),
});
const saleBody = z.object({
  lines: z.array(z.object({ productId: id, qty: z.number().int().min(1).max(1000) })).min(1),
  method: z.enum(rules.SALE_METHODS),
  memberId: id.optional(),
});
const lockerBody = z.object({
  numbers: z.array(text(1, 10)).min(1).max(200).meta({ description: 'One or more locker numbers' }),
  zone: nullable(text(1, 30)).optional(),
  size: z.enum(rules.LOCKER_SIZES).default('medium'),
  monthlyFeePoisha: poisha.min(0),
});
const lockerPatch = z
  .object({ zone: nullable(text(1, 30)).optional(), size: z.enum(rules.LOCKER_SIZES).optional(), monthlyFeePoisha: poisha.min(0).optional(), status: z.enum(['available', 'out_of_service', 'retired']).optional(), note: nullable(text(1, 200)).optional() })
  .refine((b) => Object.keys(b).length > 0, 'Nothing to change');
const rentBody = z.object({
  memberId: id,
  startsOn: date.optional(),
  endsOn: date,
  feePoisha: poisha.min(0).optional().meta({ description: 'Default: the monthly fee for each started 30 days' }),
  collect: z.object({ method: z.enum(rules.SALE_METHODS) }).optional().meta({ description: 'Take the fee now (a counter sale and its receipt)' }),
});
const collectBody = z.object({ method: z.enum(rules.SALE_METHODS) });

// ---------------- responses
const Category = z.object({ id, key: nullable(z.string()), name: z.string(), sort: z.number().int(), status: z.enum(['active', 'retired']) }).meta({ id: 'GymExpenseCategory' });
const Categories = z.object({ items: z.array(Category) }).meta({ id: 'GymExpenseCategories' });
const Expense = z
  .object({
    id,
    category: z.object({ id, name: z.string(), key: nullable(z.string()) }),
    amountPoisha: poisha,
    spentOn: date,
    method: z.enum(rules.EXPENSE_METHODS),
    fromDrawer: z.boolean(),
    payee: nullable(z.string()),
    note: nullable(z.string()),
    source: z.enum(['manual', 'payroll', 'asset']),
    status: z.enum(['recorded', 'void']),
    voidReason: nullable(z.string()),
    createdBy: nullable(z.string()),
    createdAt: dateTime,
  })
  .meta({ id: 'GymExpense' });
const Expenses = z.object({ items: z.array(Expense), totalPoisha: poisha, nextCursor: nullable(z.string()) }).meta({ id: 'GymExpenses' });
const Drawer = z
  .object({
    date,
    status: z.enum(['not_open', 'open', 'closed']),
    openingPoisha: nullable(poisha),
    openedBy: nullable(z.string()),
    openedAt: nullable(dateTime),
    cash: z.object({ feesPoisha: poisha, salesPoisha: poisha, expensesPoisha: poisha, expectedPoisha: nullable(poisha) }),
    countedPoisha: nullable(poisha),
    differencePoisha: nullable(poisha),
    closedBy: nullable(z.string()),
    closedAt: nullable(dateTime),
    closeNote: nullable(z.string()),
  })
  .meta({ id: 'GymDrawer' });
const Product = z
  .object({
    id,
    name: z.string(),
    barcode: nullable(z.string()),
    category: z.enum(rules.PRODUCT_CATEGORIES),
    pricePoisha: poisha,
    costPoisha: nullable(poisha).optional().meta({ description: 'stock.manage and the owner only' }),
    stockQty: z.number().int(),
    reorderLevel: z.number().int(),
    low: z.boolean(),
    batchNo: nullable(z.string()),
    expiresOn: nullable(date),
    expired: z.boolean(),
    importer: nullable(z.string()),
    status: z.enum(['active', 'retired']),
  })
  .meta({ id: 'GymProduct' });
const Products = z.object({ items: z.array(Product) }).meta({ id: 'GymProducts' });
const SaleLine = z.object({ productId: nullable(id), description: z.string(), qty: z.number().int(), unitPricePoisha: poisha, lineTotalPoisha: poisha });
const Sale = z
  .object({
    id,
    receiptNo: z.string(),
    kind: z.enum(['pos', 'locker']),
    member: nullable(z.object({ id, memberCode: z.string(), displayName: z.string() })),
    lines: z.array(SaleLine),
    totalPoisha: poisha,
    vat: nullable(z.object({ bps: z.number().int(), vat: poisha, net: poisha })),
    method: z.enum(rules.SALE_METHODS),
    soldOn: date,
    soldBy: nullable(z.string()),
    status: z.enum(['recorded', 'reversed']),
    reverseReason: nullable(z.string()),
    reversedOn: nullable(date),
    createdAt: dateTime,
    gym: z.object({ id, name: z.string(), addressLine: nullable(z.string()), tin: nullable(z.string()), bin: nullable(z.string()), footer: nullable(z.string()) }).optional(),
  })
  .meta({ id: 'GymSale' });
const Sales = z.object({ items: z.array(Sale), nextCursor: nullable(z.string()) }).meta({ id: 'GymSales' });
const Rental = z
  .object({
    id,
    lockerId: id,
    lockerNumber: z.string(),
    member: z.object({ id, memberCode: z.string(), displayName: z.string() }),
    startsOn: date,
    endsOn: date,
    feePoisha: poisha,
    paid: z.boolean(),
    paidSaleId: nullable(id),
    status: z.enum(['active', 'ended', 'cancelled']),
    endReason: nullable(z.string()),
  })
  .meta({ id: 'GymLockerRental' });
const Locker = z
  .object({
    id,
    number: z.string(),
    zone: nullable(z.string()),
    size: z.enum(rules.LOCKER_SIZES),
    monthlyFeePoisha: poisha,
    status: z.enum(['available', 'out_of_service', 'retired']),
    state: z.enum(['free', 'taken', 'unpaid', 'overdue', 'out_of_service']),
    note: nullable(z.string()),
    rental: nullable(Rental),
  })
  .meta({ id: 'GymLocker' });
const Lockers = z.object({ items: z.array(Locker), counts: z.object({ free: z.number().int(), taken: z.number().int(), unpaid: z.number().int(), overdue: z.number().int(), outOfService: z.number().int() }) }).meta({ id: 'GymLockers' });
const Rentals = z.object({ items: z.array(Rental) }).meta({ id: 'GymLockerRentals' });
const PnlTotals = z.object({
  income: z.object({ fees: poisha, posSales: poisha, lockerFees: poisha, total: poisha }),
  goodsCost: poisha,
  gross: poisha,
  expenses: z.object({ total: poisha, byCategory: z.array(z.object({ categoryId: id, name: z.string(), amount: poisha })) }),
  net: poisha,
});
const Pnl = z.object({ from: date, to: date, current: PnlTotals, previous: PnlTotals.extend({ from: date, to: date }) }).meta({ id: 'GymProfitAndLoss' });

module.exports = {
  gymParam,
  expenseParam,
  productParam,
  saleParam,
  lockerParam,
  rentalParam,
  periodQuery,
  expenseQuery,
  dayQuery,
  productQuery,
  saleQuery,
  rentalQuery,
  categoriesBody,
  expenseBody,
  reasonBody,
  openBody,
  closeBody,
  productBody,
  productPatch,
  stockBody,
  saleBody,
  lockerBody,
  lockerPatch,
  rentBody,
  collectBody,
  Categories,
  Expense,
  Expenses,
  Drawer,
  Product,
  Products,
  Sale,
  Sales,
  Locker,
  Lockers,
  Rental,
  Rentals,
  Pnl,
};
