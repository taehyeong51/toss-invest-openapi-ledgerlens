import type { DecimalString } from "../toss/types";

export const EXTERNAL_ASSET_KINDS = [
  "cash",
  "deposit",
  "savings",
  "pension",
  "insurance",
  "property",
  "crypto",
  "other",
] as const;

export type ExternalAssetKind = (typeof EXTERNAL_ASSET_KINDS)[number];
export type ExternalAssetSource = "manual";

export interface ExternalAssetInput {
  kind: ExternalAssetKind;
  name: string;
  institution: string;
  currency: string;
  balance: DecimalString;
  valueKrw: DecimalString;
  valuedAt: string;
  maturityDate: string | null;
  annualRatePercent: DecimalString | null;
  note: string;
}

export interface ExternalAssetUpdateInput extends ExternalAssetInput {
  id: string;
  expectedRevision: number;
}

export interface ExternalAssetRecord extends ExternalAssetInput {
  id: string;
  source: ExternalAssetSource;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export interface ExternalAssetsPayload {
  status: "demo" | "ready";
  assets: ExternalAssetRecord[];
  count: number;
  totalValueKrw: DecimalString;
  lastUpdatedAt: string | null;
}

export interface ExternalAssetSummary {
  count: number;
  totalValueKrw: DecimalString;
  lastUpdatedAt: string | null;
}

export interface ExternalAssetCreateResponse {
  asset: ExternalAssetRecord;
  created: boolean;
  payload: ExternalAssetsPayload;
}

export interface ExternalAssetUpdateResponse {
  asset: ExternalAssetRecord;
  updated: boolean;
  payload: ExternalAssetsPayload;
}
