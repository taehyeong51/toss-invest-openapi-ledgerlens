import type {
  NewReviewJournalEntry,
  ReviewStatusUpdate,
} from "./types";

const REVIEW_ID = /^rv_[a-f0-9]{40}$/;

function hasControlCharacter(value: string): boolean {
  return Array.from(value).some((character) => {
    const code = character.charCodeAt(0);
    return code <= 31 || code === 127;
  });
}

export class ReviewValidationError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "ReviewValidationError";
    this.code = code;
  }
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ReviewValidationError("invalid-review", "검토 기록 형식이 올바르지 않습니다.");
  }
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, keys: string[]): void {
  if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...keys].sort())) {
    throw new ReviewValidationError("invalid-review", "검토 기록 필드를 확인해 주세요.");
  }
}

function canonicalTimestamp(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new ReviewValidationError("invalid-review", `${field} 시각이 필요합니다.`);
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    throw new ReviewValidationError("invalid-review", `${field} 시각 형식이 올바르지 않습니다.`);
  }
  return value;
}

function revision(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1 || Number(value) > 2_147_483_647) {
    throw new ReviewValidationError("invalid-review", "검토 기록 revision이 올바르지 않습니다.");
  }
  return Number(value);
}

export function parseNewReviewJournalEntry(value: unknown): NewReviewJournalEntry {
  const body = record(value);
  exactKeys(body, [
    "action",
    "cashFlowConfirmation",
    "periodEndedAt",
    "periodStartedAt",
    "planRevision",
    "snapshotCount",
  ]);
  const periodStartedAt = canonicalTimestamp(body.periodStartedAt, "기간 시작");
  const periodEndedAt = canonicalTimestamp(body.periodEndedAt, "기간 종료");
  if (periodStartedAt >= periodEndedAt) {
    throw new ReviewValidationError("invalid-review", "검토 종료 시각은 시작 시각 이후여야 합니다.");
  }
  if (body.cashFlowConfirmation !== "complete" && body.cashFlowConfirmation !== "incomplete") {
    throw new ReviewValidationError("invalid-review", "외부 입출금 기록 여부를 확인해 주세요.");
  }
  if (typeof body.action !== "string") {
    throw new ReviewValidationError("invalid-review", "다음 검토 전 행동을 입력해 주세요.");
  }
  const action = body.action.trim();
  if (!action || action.length > 240 || hasControlCharacter(action)) {
    throw new ReviewValidationError(
      "invalid-review",
      "다음 검토 전 행동은 1~240자의 한 줄 텍스트여야 합니다.",
    );
  }
  if (!Number.isSafeInteger(body.snapshotCount) || Number(body.snapshotCount) < 0 || Number(body.snapshotCount) > 365) {
    throw new ReviewValidationError("invalid-review", "스냅샷 수가 올바르지 않습니다.");
  }
  const planRevision = body.planRevision === null ? null : revision(body.planRevision);
  return {
    periodStartedAt,
    periodEndedAt,
    cashFlowConfirmation: body.cashFlowConfirmation,
    action,
    snapshotCount: Number(body.snapshotCount),
    planRevision,
  };
}

export function parseReviewStatusUpdate(value: unknown): ReviewStatusUpdate {
  const body = record(value);
  exactKeys(body, ["expectedRevision", "id", "status"]);
  if (typeof body.id !== "string" || !REVIEW_ID.test(body.id)) {
    throw new ReviewValidationError("invalid-review", "검토 기록 ID가 올바르지 않습니다.");
  }
  if (body.status !== "open" && body.status !== "resolved") {
    throw new ReviewValidationError("invalid-review", "검토 행동 상태가 올바르지 않습니다.");
  }
  return {
    id: body.id,
    status: body.status,
    expectedRevision: revision(body.expectedRevision),
  };
}
