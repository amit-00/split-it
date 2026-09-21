export interface Amount {
  userId: string;
  amountMinor: number;
}

export type Split =
  | { type: 'equal'; userIds: string[] }
  | { type: 'exact'; shares: Amount[] };

export interface Allocation {
  debtorUserId: string;
  creditorUserId: string;
  amountMinor: number;
}

const compareUserIds = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0;

function validateAmountList(amounts: Amount[], name: string): void {
  if (!Array.isArray(amounts) || amounts.length === 0) {
    throw new RangeError(`${name} must contain at least one entry`);
  }

  const userIds = new Set<string>();
  for (const amount of amounts) {
    if (typeof amount !== 'object' || amount === null || typeof amount.userId !== 'string' || amount.userId.length === 0) {
      throw new TypeError(`${name} userId must be a non-empty string`);
    }
    if (!Number.isSafeInteger(amount.amountMinor)) {
      throw new TypeError(`${name} amountMinor must be a safe integer`);
    }
    if (amount.amountMinor <= 0) {
      throw new RangeError(`${name} amountMinor must be positive for user ${amount.userId}`);
    }
    if (userIds.has(amount.userId)) {
      throw new RangeError(`duplicate user in ${name}: ${amount.userId}`);
    }
    userIds.add(amount.userId);
  }
}

function validateEqualUserIds(userIds: string[]): void {
  if (!Array.isArray(userIds) || userIds.length === 0) {
    throw new RangeError('equal split must contain at least one participant');
  }

  const unique = new Set<string>();
  for (const userId of userIds) {
    if (typeof userId !== 'string' || userId.length === 0) {
      throw new TypeError('equal split userId must be a non-empty string');
    }
    if (unique.has(userId)) {
      throw new RangeError(`duplicate user in equal split: ${userId}`);
    }
    unique.add(userId);
  }
}

function sumAmounts(amounts: Amount[]): bigint {
  return amounts.reduce((sum, amount) => sum + BigInt(amount.amountMinor), 0n);
}

export function allocateExpense(
  total: number,
  payments: Amount[],
  split: Split,
): { shares: Amount[]; allocations: Allocation[] } {
  if (!Number.isSafeInteger(total)) {
    throw new TypeError('total must be a safe integer number of cents');
  }
  if (total <= 0) {
    throw new RangeError('total must be positive');
  }

  validateAmountList(payments, 'payments');
  const totalMinor = BigInt(total);
  if (sumAmounts(payments) !== totalMinor) {
    throw new RangeError('payments sum must equal total');
  }
  if (!split || typeof split !== 'object') {
    throw new TypeError('split must be an equal or exact split');
  }

  let shares: Amount[];
  if (split.type === 'equal') {
    validateEqualUserIds(split.userIds);
    if (total < split.userIds.length) {
      throw new RangeError('total must provide at least one cent per equal split participant');
    }
    const userIds = [...split.userIds].sort(compareUserIds);
    const count = BigInt(userIds.length);
    const base = totalMinor / count;
    const remainder = Number(totalMinor % count);
    shares = userIds.map((userId, index) => ({
      userId,
      amountMinor: Number(base + (index < remainder ? 1n : 0n)),
    }));
  } else if (split.type === 'exact') {
    validateAmountList(split.shares, 'shares');
    if (sumAmounts(split.shares) !== totalMinor) {
      throw new RangeError('shares sum must equal total');
    }
    shares = split.shares.map(share => ({ ...share })).sort((left, right) => compareUserIds(left.userId, right.userId));
  } else {
    throw new TypeError('split type must be equal or exact');
  }

  const participantIds = new Set([...payments.map(payment => payment.userId), ...shares.map(share => share.userId)]);
  if (participantIds.size > 50) {
    throw new RangeError('expense cannot contain more than 50 distinct users');
  }

  const netByUser = new Map<string, bigint>();
  for (const payment of payments) netByUser.set(payment.userId, BigInt(payment.amountMinor));
  for (const share of shares) netByUser.set(share.userId, (netByUser.get(share.userId) ?? 0n) - BigInt(share.amountMinor));

  const debtors = [...netByUser]
    .filter(([, net]) => net < 0n)
    .map(([userId, net]) => ({ userId, amount: -net }))
    .sort((left, right) => compareUserIds(left.userId, right.userId));
  const creditors = [...netByUser]
    .filter(([, net]) => net > 0n)
    .map(([userId, amount]) => ({ userId, amount }))
    .sort((left, right) => compareUserIds(left.userId, right.userId));

  const allocations: Allocation[] = [];
  let debtorIndex = 0;
  let creditorIndex = 0;
  while (debtorIndex < debtors.length && creditorIndex < creditors.length) {
    const debtor = debtors[debtorIndex];
    const creditor = creditors[creditorIndex];
    const amount = debtor.amount < creditor.amount ? debtor.amount : creditor.amount;
    allocations.push({ debtorUserId: debtor.userId, creditorUserId: creditor.userId, amountMinor: Number(amount) });
    debtor.amount -= amount;
    creditor.amount -= amount;
    if (debtor.amount === 0n) debtorIndex++;
    if (creditor.amount === 0n) creditorIndex++;
  }

  return { shares, allocations };
}
