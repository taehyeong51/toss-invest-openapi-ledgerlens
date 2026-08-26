import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";
import { createServer } from "vite";

const root = fileURLToPath(new URL("../", import.meta.url));
let vite;

before(async () => {
  vite = await createServer({
    root,
    configFile: false,
    appType: "custom",
    logLevel: "silent",
    resolve: { alias: [{ find: "@", replacement: root }] },
    server: { middlewareMode: true },
  });
});

after(async () => {
  await vite?.close();
});

test("encrypts local Toss credentials, expires memory access, and requires the passphrase", async () => {
  const vault = await vite.ssrLoadModule("/lib/credentials/vault.ts");
  const directory = await mkdtemp(join(tmpdir(), "ledgerlens-vault-"));
  const filePath = join(directory, "vault.json");
  const passphrase = "correct horse battery staple";
  const original = {
    clientId: "test-client-id-never-real",
    clientSecret: "test-client-secret-never-real",
    preferredAccountSeq: 11,
  };

  try {
    await vault.saveTossCredentialVault(original, passphrase, { filePath });
    const stored = await readFile(filePath, "utf8");
    assert.doesNotMatch(stored, /test-client-id-never-real/);
    assert.doesNotMatch(stored, /test-client-secret-never-real/);
    assert.doesNotMatch(stored, /correct horse battery staple/);
    assert.match(stored, /"name": "AES-GCM"/);
    assert.match(stored, /"iterations": 310000/);

    assert.deepEqual(
      await vault.decryptTossCredentialVault(passphrase, { filePath }),
      original,
    );
    await assert.rejects(
      vault.decryptTossCredentialVault("wrong passphrase 123", { filePath }),
      (error) => error?.code === "vault-unlock-failed",
    );

    const start = Date.parse("2026-08-26T00:00:00.000Z");
    const expiresAt = vault.activateTossCredentials(original, () => start);
    assert.equal(expiresAt, "2026-08-26T08:00:00.000Z");
    assert.equal(
      (await vault.getTossCredentialVaultStatus({ filePath, now: () => start + 1 })).unlocked,
      true,
    );
    assert.equal(
      (await vault.getTossCredentialVaultStatus({
        filePath,
        now: () => start + 8 * 60 * 60 * 1_000,
      })).unlocked,
      false,
    );

    await assert.rejects(
      vault.saveTossCredentialVault(
        { ...original, clientSecret: "replacement-secret" },
        "wrong passphrase 123",
        { filePath },
      ),
      (error) => error?.code === "vault-unlock-failed",
    );
    assert.deepEqual(
      await vault.decryptTossCredentialVault(passphrase, { filePath }),
      original,
    );

    await assert.rejects(
      vault.deleteTossCredentialVault("wrong passphrase 123", { filePath }),
      (error) => error?.code === "vault-unlock-failed",
    );
    await access(filePath);
    await vault.deleteTossCredentialVault(passphrase, { filePath });
    await assert.rejects(access(filePath), { code: "ENOENT" });
  } finally {
    vault.lockTossCredentialVault();
    await rm(directory, { recursive: true, force: true });
  }
});

test("credential API is loopback-only, same-origin, masked, encrypted, and lifecycle-safe", async () => {
  const route = await vite.ssrLoadModule("/app/api/toss-credentials/route.ts");
  const vault = await vite.ssrLoadModule("/lib/credentials/vault.ts");
  const directory = await mkdtemp(join(tmpdir(), "ledgerlens-route-vault-"));
  const previousDirectory = process.cwd();
  const originalFetch = globalThis.fetch;
  const environmentKeys = [
    "TOSS_RELAY_URL",
    "TOSS_RELAY_TOKEN",
    "TOSS_RELAY_ACCOUNT_KEY",
    "TOSS_DIRECT_API_ENABLED",
    "TOSS_CLIENT_ID",
    "TOSS_CLIENT_SECRET",
    "TOSS_ACCOUNT_SEQ",
  ];
  const originalEnvironment = new Map(environmentKeys.map((key) => [key, process.env[key]]));
  const clientId = `route-client-${Date.now()}`;
  const clientSecret = "route-secret-never-real";
  const passphrase = "route vault passphrase 123";
  let tokenRequests = 0;

  function request(method, path = "", intent, body, origin = "http://localhost") {
    return new Request(`http://localhost/api/toss-credentials${path}`, {
      method,
      headers: {
        Accept: "application/json",
        Origin: origin,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        ...(intent ? { "X-LedgerLens-Intent": intent } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }

  try {
    for (const key of environmentKeys) delete process.env[key];
    process.chdir(directory);
    vault.lockTossCredentialVault();
    globalThis.fetch = async (input, init = {}) => {
      const url = new URL(input);
      if (url.pathname === "/oauth2/token") {
        tokenRequests += 1;
        const form = new URLSearchParams(String(init.body));
        if (form.get("client_secret") === "invalid-secret") {
          return Response.json({ error: "invalid_client" }, { status: 401 });
        }
        if (form.get("client_secret") === "blocked-ip-secret") {
          return Response.json({ error: "forbidden" }, { status: 403 });
        }
        return Response.json({
          access_token: `route-token-${tokenRequests}`,
          token_type: "Bearer",
          expires_in: 3600,
        });
      }
      assert.equal(url.pathname, "/api/v1/accounts");
      assert.match(new Headers(init.headers).get("authorization") ?? "", /^Bearer route-token-/);
      return Response.json({
        result: [
          { accountNo: "12345678901234", accountSeq: 11, accountType: "BROKERAGE" },
          { accountNo: "98765432105678", accountSeq: 22, accountType: "PENSION_SAVINGS" },
        ],
      });
    };

    const remoteStatus = await route.GET(new Request("https://ledgerlens.example/api/toss-credentials"));
    assert.equal(remoteStatus.status, 403);
    assert.equal((await remoteStatus.json()).error.code, "local-vault-only");

    const initialStatus = await route.GET(request("GET"));
    assert.equal(initialStatus.status, 200);
    assert.deepEqual(await initialStatus.json(), {
      available: true,
      activeSource: "demo",
      vault: { exists: false, unlocked: false, expiresAt: null },
      storage: "local-encrypted-file",
    });

    const missingIntent = await route.POST(request("POST", "", undefined, { clientId, clientSecret }));
    assert.equal(missingIntent.status, 428);
    const crossOrigin = await route.POST(
      request(
        "POST",
        "",
        "validate-toss-credentials",
        { clientId, clientSecret },
        "https://attacker.example",
      ),
    );
    assert.equal(crossOrigin.status, 403);

    const invalidCredentials = await route.POST(
      request("POST", "", "validate-toss-credentials", {
        clientId: `${clientId}-invalid`,
        clientSecret: "invalid-secret",
      }),
    );
    assert.equal(invalidCredentials.status, 422);
    assert.equal((await invalidCredentials.json()).error.code, "toss-credentials-invalid");

    const blockedIp = await route.POST(
      request("POST", "", "validate-toss-credentials", {
        clientId: `${clientId}-blocked-ip`,
        clientSecret: "blocked-ip-secret",
      }),
    );
    assert.equal(blockedIp.status, 422);
    assert.equal((await blockedIp.json()).error.code, "toss-ip-not-allowed");

    const validation = await route.POST(
      request("POST", "", "validate-toss-credentials", { clientId, clientSecret }),
    );
    assert.equal(validation.status, 200);
    const validationText = await validation.text();
    assert.doesNotMatch(validationText, new RegExp(clientSecret));
    assert.doesNotMatch(validationText, /12345678901234|98765432105678/);
    assert.match(validationText, /•••• 1234/);
    assert.match(validationText, /•••• 5678/);

    const stringAccount = await route.PUT(
      request("PUT", "", "save-toss-credentials", {
        clientId,
        clientSecret,
        passphrase,
        preferredAccountSelection: "0",
      }),
    );
    assert.equal(stringAccount.status, 400);

    const saved = await route.PUT(
      request("PUT", "", "save-toss-credentials", {
        clientId,
        clientSecret,
        passphrase,
        preferredAccountSelection: 0,
      }),
    );
    assert.equal(saved.status, 200);
    assert.equal((await saved.json()).selectedAccount.maskedNumber, "•••• 1234");
    const encrypted = await readFile(join(directory, "private-data", "toss-credentials.v1.json"), "utf8");
    assert.doesNotMatch(encrypted, new RegExp(clientId));
    assert.doesNotMatch(encrypted, new RegExp(clientSecret));
    assert.doesNotMatch(encrypted, new RegExp(passphrase));

    const unlockedStatus = await route.GET(request("GET"));
    const unlockedPayload = await unlockedStatus.json();
    assert.equal(unlockedPayload.activeSource, "vault");
    assert.equal(unlockedPayload.vault.unlocked, true);

    assert.equal(
      (await route.PATCH(
        request("PATCH", "", "manage-toss-credential-vault", { action: "lock" }),
      )).status,
      200,
    );
    const lockedPayload = await (await route.GET(request("GET"))).json();
    assert.equal(lockedPayload.activeSource, "demo");
    assert.equal(lockedPayload.vault.unlocked, false);

    const wrongUnlock = await route.PATCH(
      request("PATCH", "", "manage-toss-credential-vault", {
        action: "unlock",
        passphrase: "wrong passphrase 123",
      }),
    );
    assert.equal(wrongUnlock.status, 401);
    assert.equal((await wrongUnlock.json()).error.code, "vault-unlock-failed");

    const unlocked = await route.PATCH(
      request("PATCH", "", "manage-toss-credential-vault", { action: "unlock", passphrase }),
    );
    assert.equal(unlocked.status, 200);
    assert.equal((await unlocked.json()).unlocked, true);

    const deleted = await route.DELETE(
      request("DELETE", "", "delete-toss-credential-vault", { passphrase }),
    );
    assert.equal(deleted.status, 200);
    assert.equal((await deleted.json()).deleted, true);
    assert.equal((await route.GET(request("GET"))).status, 200);
  } finally {
    vault.lockTossCredentialVault();
    globalThis.fetch = originalFetch;
    process.chdir(previousDirectory);
    for (const [key, value] of originalEnvironment) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(directory, { recursive: true, force: true });
  }
});
