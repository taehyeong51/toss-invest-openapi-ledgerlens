import type { DecimalString } from "../toss/types";

export type CashFlowKind = "contribution" | "withdrawal";

export interface CashFlowRecord {
  id: string;
  occurredAt: string;
  createdAt: string;
  kind: CashFlowKind;
  amountKrw: DecimalString;
  note: string;
}

export interface CashFlowListResponse {
  cashFlows: CashFlowRecord[];
  count: number;
}

export interface CashFlowCreateResponse {
  cashFlow: CashFlowRecord;
  created: boolean;
}

export interface NewManualCashFlow {
  occurredAt: string;
  kind: CashFlowKind;
  amountKrw: DecimalString;
  note: string;
}
