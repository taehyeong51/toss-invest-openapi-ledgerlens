export type ReviewCashFlowConfirmation = "complete" | "incomplete";
export type ReviewActionStatus = "open" | "resolved";

export interface NewReviewJournalEntry {
  periodStartedAt: string;
  periodEndedAt: string;
  cashFlowConfirmation: ReviewCashFlowConfirmation;
  action: string;
  snapshotCount: number;
  planRevision: number | null;
}

export interface ReviewJournalEntry extends NewReviewJournalEntry {
  id: string;
  status: ReviewActionStatus;
  revision: number;
  createdAt: string;
  updatedAt: string;
  resolvedAt: string | null;
}

export interface ReviewJournalListResponse {
  status: "demo" | "ready";
  reviews: ReviewJournalEntry[];
  count: number;
}

export interface ReviewJournalCreateResponse {
  review: ReviewJournalEntry;
  created: boolean;
}

export interface ReviewStatusUpdate {
  id: string;
  status: ReviewActionStatus;
  expectedRevision: number;
}
