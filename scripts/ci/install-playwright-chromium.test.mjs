// scripts/install-playwright-chromium.sh against stub sudo, timeout, sleep and npx: which
// commands it runs, in what order, and when it retries (VAY-2314).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const SCRIPT = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "install-playwright-chromium.sh",
);
// The runner's mirror list; the script only rewrites it where it exists.
const MIRRORS = existsSync("/etc/apt/apt-mirrors.txt");

// Each stub appends its command line to calls.log. npx fails the first $FAIL_DEPS install-deps
// and the first $FAIL_BROWSER browser installs.
function install({ failDeps = 0, failBrowser = 0, debs = [] } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "install-chromium-"));
  const archives = join(dir, "archives");
  spawnSync("mkdir", ["-p", archives, join(dir, "bin")]);
  for (const deb of debs) writeFileSync(join(archives, deb), "");
  const stub = (name, body) => {
    writeFileSync(join(dir, "bin", name), `#!/usr/bin/env bash\n${body}\n`);
    chmodSync(join(dir, "bin", name), 0o755);
  };
  const log = `echo "${"$"}(basename "$0") $*" >> "${dir}/calls.log"`;
  stub("sudo", `${log}\n[ "$1" = tee ] && cat > /dev/null\nexit 0`);
  stub("sleep", log);
  stub("timeout", `${log}\nshift\nexec "$@"`);
  stub(
    "npx",
    `${log}
key=$([ "$2" = install-deps ] && echo deps || echo browser)
count=$(( $(cat "${dir}/$key" 2>/dev/null || echo 0) + 1 ))
echo $count > "${dir}/$key"
limit=$([ $key = deps ] && echo "$FAIL_DEPS" || echo "$FAIL_BROWSER")
[ $count -gt $limit ]`,
  );
  const result = spawnSync("bash", [SCRIPT], {
    encoding: "utf8",
    env: {
      PATH: `${join(dir, "bin")}:${process.env.PATH}`,
      PLAYWRIGHT_APT_ARCHIVES: archives,
      FAIL_DEPS: String(failDeps),
      FAIL_BROWSER: String(failBrowser),
    },
  });
  const calls = readFileSync(join(dir, "calls.log"), "utf8").trim().split("\n");
  return { status: result.status, stdout: result.stdout, calls, archives };
}

const DOWNLOAD_ONLY = "/etc/apt/apt.conf.d/99-playwright-download-only";
const DEPS = "npx playwright install-deps chromium";
const BROWSER = "npx playwright install --only-shell chromium";

test("downloads the packages download-only, installs them offline, then fetches the headless shell", () => {
  const { status, stdout, calls, archives } = install({ debs: ["fonts-unifont.deb"] });
  assert.equal(status, 0);
  assert.deepEqual(calls, [
    "sudo apt-get clean",
    `sudo tee ${DOWNLOAD_ONLY}`,
    `timeout 150 ${DEPS}`,
    DEPS,
    `sudo rm -f ${DOWNLOAD_ONLY}`,
    `sudo apt-get install -y --no-install-recommends ${archives}/fonts-unifont.deb`,
    BROWSER,
    `sudo rm -f ${DOWNLOAD_ONLY}`,
  ]);
  assert.doesNotMatch(stdout, /Infra retry/);
});

test("installs nothing from apt when the runner already has every package", () => {
  const { status, calls } = install();
  assert.equal(status, 0);
  assert.ok(!calls.some((call) => call.startsWith("sudo apt-get install")));
});

test("a failed package download stops its apt-get, leaves the Azure mirror, waits and tries again", () => {
  const { status, stdout, calls } = install({ failDeps: 1 });
  assert.equal(status, 0);
  assert.match(
    stdout,
    /::warning title=Infra retry::System packages for Chromium failed or took over 150s \(attempt 1 of 3\)/,
  );
  const first = calls.indexOf(DEPS);
  const second = calls.indexOf(`timeout 150 ${DEPS}`, first);
  assert.deepEqual(
    calls.slice(first + 1, second).map((call) => call.split(" ").slice(0, 4).join(" ")),
    [
      "sudo pkill -f [a]pt-get",
      "sudo pkill -x apt-get",
      ...(MIRRORS
        ? [
            "sudo sed -i s|http://azure.archive.ubuntu.com/ubuntu|https://archive.ubuntu.com/ubuntu|g",
          ]
        : []),
      "sleep 30",
    ],
  );
  assert.equal(calls.filter((call) => call === DEPS).length, 2);
});

test("a failed browser download is retried after a pause, never stopped for being slow", () => {
  const { status, stdout, calls } = install({ failBrowser: 2 });
  assert.equal(status, 0);
  assert.equal(
    stdout.match(/::warning title=Infra retry::Chromium download failed \(attempt [12] of 3\)/g)
      .length,
    2,
  );
  // A stopped download starts over, and Playwright drops a stalled connection itself.
  assert.deepEqual(
    calls.filter((call) => call.endsWith(BROWSER)),
    [BROWSER, BROWSER, BROWSER],
  );
  assert.deepEqual(
    calls.filter((call) => call.startsWith("sleep")),
    ["sleep 30", "sleep 60"],
  );
});

test("three failed attempts fail the step with an error annotation", () => {
  const { status, stdout, calls } = install({ failBrowser: 3 });
  assert.equal(status, 1);
  assert.match(stdout, /::error title=Infra retry::Chromium download failed 3 times/);
  // The download-only setting never outlives the script.
  assert.equal(calls.at(-1), `sudo rm -f ${DOWNLOAD_ONLY}`);
});
