export interface CapitalPlanInput {
  startAssetKrw: string;
  targetAssetKrw: string;
  startDate: string;
  targetDate: string;
  monthlyContributionKrw: string;
  targetKrWeight: string;
  targetUsWeight: string;
  targetCashWeight: string;
  expectedRevision: number;
}

export interface StoredCapitalPlan extends Omit<CapitalPlanInput, "expectedRevision" | "startAssetKrw"> {
  id: string;
  ownerId: string;
  accountKey: string;
  /** Null means a pre-migration plan whose starting balance was never confirmed. */
  startAssetKrw: string | null;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export type CapitalPlanView = Omit<StoredCapitalPlan, "ownerId" | "accountKey">;

export interface CapitalPlanResponse {
  status: "demo" | "unconfigured" | "ready";
  plan: CapitalPlanView | null;
}

export function capitalPlanView(plan: StoredCapitalPlan): CapitalPlanView {
  return {
    id: plan.id,
    startAssetKrw: plan.startAssetKrw,
    targetAssetKrw: plan.targetAssetKrw,
    startDate: plan.startDate,
    targetDate: plan.targetDate,
    monthlyContributionKrw: plan.monthlyContributionKrw,
    targetKrWeight: plan.targetKrWeight,
    targetUsWeight: plan.targetUsWeight,
    targetCashWeight: plan.targetCashWeight,
    revision: plan.revision,
    createdAt: plan.createdAt,
    updatedAt: plan.updatedAt,
  };
}
