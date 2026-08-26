# 고정 egress Relay 배포

LedgerLens의 모바일 Sites 배포는 Toss Client ID와 Client Secret을 직접 보관하지 않는다.
별도의 단일 인스턴스가 Toss에 직접 연결하고, Sites는 HTTPS Bearer 인증이 적용된
`GET /api/relay/portfolio`만 호출한다.

## 공개 경계

`Dockerfile.relay`는 Vinext의 추적된 standalone 서버만 런타임 이미지에 복사하고
이를 컨테이너의 loopback 주소에만 바인딩한다. TypeScript, ESLint, Wrangler,
Cloudflare/Vite 빌드 플러그인과 전체 저장소 소스는 최종 이미지에 포함하지 않는다.
외부 포트에는 `infra/relay/gateway.mjs`만 노출되며 다음 두 경로만 허용한다.

- `GET /healthz`: Toss를 호출하지 않는 프로세스 준비 상태
- `GET /api/relay/portfolio`: Relay Bearer 토큰이 필요한 읽기 전용 포트폴리오

대시보드, 일반 `/api/portfolio`, 주문 경로, 임의 프록시, 쿼리 및 요청 본문은
고정 IP 호스트의 공개 인터페이스에 노출하지 않는다.

빌드 단계는 잠긴 전체 의존성으로 앱을 컴파일하지만 최종 단계에는
`dist/standalone`과 `infra/relay`만 전달한다. 따라서 개발 도구의 감사 결과는
Relay 공격면과 분리된다. `npm audit --omit=dev`가 깨끗한지와 standalone 안에
`drizzle-kit`, `vite`, `wrangler`가 없는지를 배포 전 확인한다.

## Fly.io 배포안

`fly.relay.toml`은 가장 가까운 현재 지원 리전인 Tokyo(`nrt`)의 단일 상시 실행
Machine을 사용한다. 첫 배포 후 반드시 앱 범위 정적 egress IPv4를 하나 할당하고,
그 IPv4만 Toss WTS의 Open API 허용 IP에 등록한다.

Fly는 HTTP 서비스를 가진 앱의 첫 배포에서 기본적으로 두 Machine을 만들 수 있다.
토스는 Client 하나당 유효 OAuth 토큰 하나만 허용하므로 Relay는 반드시 한
프로세스만 실행해야 한다. 최초 배포와 검증은 다음 경계를 지킨다.

```text
fly deploy --ha=false --config fly.relay.toml
fly scale count 1 --app <app-name>
fly scale show --app <app-name>
```

`min_machines_running = 1`은 최소 실행 수일 뿐 최대 수를 제한하지 않는다. 배포와
재배포 뒤 `fly scale show`에서 `app` 프로세스가 정확히 한 Machine인지 확인한다.
두 개 이상이면 Relay 토큰을 설정하거나 WTS 허용 IP를 등록하기 전에 한 개로
축소한다.

서버 전용 secret:

```text
TOSS_CLIENT_ID
TOSS_CLIENT_SECRET
TOSS_ACCOUNT_SEQ              # 복수 계좌일 때만
LEDGERLENS_RELAY_SHARED_TOKEN # 32~512자 고엔트로피 값
LEDGERLENS_RELAY_ACCOUNT_REF  # 8~128자 불투명 계좌 식별자
```

Sites 런타임에는 다음 값만 설정한다.

```text
TOSS_RELAY_URL=https://<app-name>.fly.dev/api/relay/portfolio
TOSS_RELAY_TOKEN=<LEDGERLENS_RELAY_SHARED_TOKEN과 동일>
TOSS_RELAY_ACCOUNT_KEY=<LEDGERLENS_RELAY_ACCOUNT_REF와 동일>
```

Client Secret, 원본 계좌번호, Toss access token은 Sites나 Git에 저장하지 않는다.
계좌 목록에 종합매매 계좌가 둘 이상이면 `TOSS_ACCOUNT_SEQ`를 반드시 명시하고,
최초 Relay 응답의 마스킹 계좌가 의도한 계좌인지 확인한 뒤 opaque account ref를
Sites와 연결한다.

Worker 배포 설정에는 `10 22 * * SUN-THU` UTC Cron이 포함된다. Cloudflare는
요일 숫자를 1=일요일부터 7=토요일로 해석하므로 모호한 숫자 범위를 사용하지 않는다. 이는 일요일부터
목요일 22:10 UTC, 즉 월요일부터 금요일 07:10 KST에 해당한다. 실제 스냅샷은
Sites 화면에서 해당 사용자의 자동 수집을 활성화한 뒤에만 생성된다.
