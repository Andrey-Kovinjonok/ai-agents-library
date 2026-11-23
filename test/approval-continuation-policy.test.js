import assert from "node:assert/strict";
import test from "node:test";

import {
  approvalClassFor,
  continuationDecision,
  destructiveReason,
  findExitCode,
  sanitizeVerification,
} from "ai-agents-library/approval-continuation";

test("класс node-check принимает только один относительный исходный файл", () => {
  assert.equal(approvalClassFor("node --check src/app.js"), "node-check");
  assert.equal(approvalClassFor("node --check ../app.js"), null);
  assert.equal(approvalClassFor("node --check .env"), null);
  assert.equal(approvalClassFor("node --check src/a.js && rm -rf /"), null);
});

test("снимок экрана ограничен локальным адресом и временным файлом", () => {
  const chrome = "'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'";
  assert.equal(approvalClassFor(
    `${chrome} --headless=new --screenshot=/tmp/page.png http://127.0.0.1:3000`,
  ), "localhost-headless-screenshot");
  assert.equal(approvalClassFor(
    `${chrome} --headless=new --screenshot=/tmp/page.png https://example.com`,
  ), null);
  assert.equal(approvalClassFor(
    `${chrome} --headless=new --no-sandbox --screenshot=/tmp/page.png http://localhost:3000`,
  ), null);
  assert.equal(approvalClassFor(
    `${chrome} --headless=new --screenshot=page.png http://localhost:3000`,
  ), null);
});

test("опасные формы команд получают точную причину", () => {
  assert.match(destructiveReason("git clean -fd"), /git clean/iu);
  assert.match(destructiveReason("git push origin main --force"), /force-with-lease/iu);
  assert.match(destructiveReason("sudo rm -rf /"), /deletion/iu);
  assert.match(destructiveReason("chrome --no-sandbox"), /sandbox/iu);
  assert.equal(destructiveReason("git push origin main"), null);
});

test("форма проверки скрывает секреты и отвергает файлы окружения", () => {
  const sanitized = sanitizeVerification(
    "TOKEN=secret npm test --password hunter2",
  );
  assert.equal(sanitized.includes("secret"), false);
  assert.equal(sanitized.includes("hunter2"), false);
  assert.match(sanitized, /redacted/iu);
  assert.equal(sanitizeVerification("node --check config/.env.local"), null);
});

test("код завершения находится во вложенном ответе инструмента", () => {
  assert.equal(findExitCode({ result: [{ meta: { exitCode: 17 } }] }), 17);
  assert.equal(findExitCode({ result: "none" }), null);
});

test("просьба к пользователю запрещает автоматическое продолжение", () => {
  assert.equal(continuationDecision({
    last_assistant_message: "Осталось выбрать вариант. Подтвердите решение?",
  }, true), null);
});

