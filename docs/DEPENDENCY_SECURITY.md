# 의존성 보안 기준

기준일: 2026-08-25

LedgerLens는 실제 서버에 포함되는 패키지와 빌드·마이그레이션에만 쓰는 도구를
구분한다. 보안 경고를 숨기기 위해 `npm audit fix --force`, 임의의 transitive
override 또는 기능상 과거 버전으로의 강제 다운그레이드를 사용하지 않는다.

## 현재 게이트

- `npm audit --audit-level=high`: 전체 설치 트리에서 High/Critical 0건
- `npm audit --omit=dev --audit-level=moderate`: production 트리 0건
- `npm test`: production build, standalone 추적 범위와 전체 회귀 테스트
- Relay runtime: `dist/standalone`에 추적된 서버 패키지만 포함

CI는 위 두 audit 명령을 `npm run audit:security`로 실행한다. Vinext는
`devDependencies`에 있지만 standalone 서버 런타임을 제공하므로 전체 트리의
High/Critical 게이트도 함께 유지한다.

## 2026-08-25 업데이트

- React, React DOM, React Is, React Server DOM Webpack: `19.2.8`
- Vinext: `1.0.0-beta.8`
- Vite: `8.2.2`
- `@vitejs/plugin-rsc`: `0.5.34`
- `@cloudflare/vite-plugin`: `1.53.1`
- Wrangler: `4.125.0`
- Node.js CI/Relay image: `22.23.2`

React 계열과 Vinext의 실험적 RSC peer는 정확한 버전으로 고정한다. Vinext는 아직
beta이므로 Dependabot 제안을 자동 병합하지 않고 lint, 전체 테스트, standalone
smoke test 뒤에만 반영한다.

## 남은 개발 전용 예외

전체 `npm audit`에는 Moderate 4건이 남는다. 네 항목은 각각 독립적인 배포
취약점이 아니라 다음 하나의 개발 전용 의존성 경로가 패키지 단위로 전파된 결과다.

```text
drizzle-kit@0.31.10
└─ @esbuild-kit/esm-loader@2.6.5
   └─ @esbuild-kit/core-utils@3.3.2
      └─ esbuild@0.18.20
```

이 `esbuild` 경고는 로컬 개발 서버의 요청 처리에 관한 것이며 `db:generate`용
도구 아래에만 존재한다. Relay standalone에는 `drizzle-kit`, `@esbuild-kit`과
해당 `esbuild`가 포함되지 않는다.

npm이 제안하는 자동 수정은 `drizzle-kit@0.18.1`로의 강제 다운그레이드이므로
현재 스키마·마이그레이션 호환성을 훼손할 수 있어 적용하지 않는다. Drizzle이
해당 폐기된 loader를 제거한 호환 릴리스를 내면 이 예외를 삭제하고 전체 audit의
Moderate 0건을 다시 요구한다.
