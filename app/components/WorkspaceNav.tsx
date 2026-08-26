"use client";

import { useSyncExternalStore } from "react";

export type WorkspaceView = "review" | "performance" | "portfolio" | "plan" | "data";

interface WorkspaceNavProps {
  active: WorkspaceView;
  onChange: (view: WorkspaceView) => void;
  mode: "demo" | "live" | "relay";
}

const primaryItems: Array<{ view: Exclude<WorkspaceView, "data">; label: string; short: string }> = [
  { view: "review", label: "대시보드", short: "홈" },
  { view: "performance", label: "성과", short: "성과" },
  { view: "portfolio", label: "포트폴리오", short: "자산" },
  { view: "plan", label: "자본 계획", short: "계획" },
];

type Theme = "light" | "dark";
const THEME_EVENT = "ledgerlens-theme-change";

function currentTheme(): Theme {
  return typeof document !== "undefined" && document.documentElement.dataset.theme === "dark"
    ? "dark"
    : "light";
}

function subscribeTheme(onStoreChange: () => void): () => void {
  window.addEventListener(THEME_EVENT, onStoreChange);
  window.addEventListener("storage", onStoreChange);
  return () => {
    window.removeEventListener(THEME_EVENT, onStoreChange);
    window.removeEventListener("storage", onStoreChange);
  };
}

function MarkIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="brand-mark">
      <path d="M4 18V8.5L9.1 5v9.5L14.2 11v7H20" />
      <path d="M4 18h16" />
    </svg>
  );
}

function UtilityIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M4 7h16M4 12h16M4 17h16" />
      <path d="M8 5v4M16 10v4M11 15v4" />
    </svg>
  );
}

function ThemeIcon({ theme }: { theme: Theme }) {
  return theme === "dark" ? (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
    </svg>
  ) : (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M20 15.3A8.3 8.3 0 0 1 8.7 4a8.3 8.3 0 1 0 11.3 11.3Z" />
    </svg>
  );
}

export function WorkspaceNav({ active, onChange, mode }: WorkspaceNavProps) {
  const theme = useSyncExternalStore(subscribeTheme, currentTheme, () => "light");

  function toggleTheme() {
    const nextTheme: Theme = theme === "light" ? "dark" : "light";
    document.documentElement.dataset.theme = nextTheme;
    document.documentElement.style.colorScheme = nextTheme;
    window.localStorage.setItem("ledgerlens-theme", nextTheme);
    window.dispatchEvent(new Event(THEME_EVENT));
  }

  return (
    <>
      <header className="workspace-header">
        <a href="#workspace-main" className="skip-link">본문으로 건너뛰기</a>
        <button className="brand-button" type="button" onClick={() => onChange("review")}>
          <MarkIcon />
          <span>LedgerLens</span>
        </button>
        <nav className="desktop-nav" aria-label="주요 화면">
          {primaryItems.map((item) => (
            <button
              key={item.view}
              type="button"
              aria-current={active === item.view ? "page" : undefined}
              onClick={() => onChange(item.view)}
            >
              {item.label}
            </button>
          ))}
        </nav>
        <div className="header-tools">
          <span className={`mode-indicator mode-${mode}`} role="status">
            <span aria-hidden="true" />
            {mode === "demo" ? "Demo data" : mode === "relay" ? "Relay · read only" : "Live · read only"}
          </span>
          <button
            className="theme-toggle"
            type="button"
            aria-label={theme === "light" ? "다크 테마로 전환" : "기본 테마로 전환"}
            aria-pressed={theme === "dark"}
            title={theme === "light" ? "다크 테마" : "기본 테마"}
            onClick={toggleTheme}
          >
            <ThemeIcon theme={theme} />
            <span>{theme === "light" ? "다크" : "기본"}</span>
          </button>
          <button
            className="utility-button"
            type="button"
            aria-label="데이터 연결 및 기록 관리"
            aria-current={active === "data" ? "page" : undefined}
            onClick={() => onChange("data")}
          >
            <UtilityIcon />
            <span>데이터</span>
          </button>
        </div>
      </header>

      <nav className="mobile-nav" aria-label="모바일 주요 화면">
        {primaryItems.map((item) => (
          <button
            key={item.view}
            type="button"
            aria-current={active === item.view ? "page" : undefined}
            onClick={() => onChange(item.view)}
          >
            {item.short}
          </button>
        ))}
        <button
          type="button"
          aria-current={active === "data" ? "page" : undefined}
          onClick={() => onChange("data")}
        >
          데이터
        </button>
      </nav>
    </>
  );
}
