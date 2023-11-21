#!/usr/bin/env -S deno run -A

import { exists } from "https://deno.land/std@0.207.0/fs/mod.ts";
import * as path from "https://deno.land/std@0.207.0/path/mod.ts";
import { yellow } from "https://deno.land/std@0.207.0/fmt/colors.ts";

import { Command } from "https://deno.land/x/cliffy@v1.0.0-rc.3/command/mod.ts";
import { wait as spinner } from "https://deno.land/x/wait@0.1.13/mod.ts";

const command = new Command()
  .name("setup-npmrc")
  .description("깃헙 패키지를 사용하도록 하는 .npmrc 파일을 만들어줍니다.")
  .option("-O, --org <value:string>", "깃헙 Organization 이름", {
    default: "portone-io",
  })
  .action(async (options) => {
    const { org } = options;
    if (await exists(".npmrc")) {
      console.log(`${yellow(".npmrc")} 파일이 이미 존재합니다.`);
      Deno.exit(0);
    }
    const code = await requestCode();
    console.log(
      `${yellow("!")} 우측에 일회용 코드를 복사해주세요: ${
        yellow(code.userCode)
      }`,
    );
    await print(
      `- ${yellow("Enter")}키를 눌러서 ${
        yellow("github.com")
      }으로 이동합니다... `,
    );
    await Deno.stdin.read(new Uint8Array(1));
    const { success } = await open(code.verificationUri);
    if (!success) {
      console.log(
        "웹브라우저를 여는데 실패했습니다. 아래 URL을 웹브라우저 주소창에 직접 입력해주세요.",
      );
      console.log(code.verificationUri);
    }
    const { accessToken } = await pollToken(code);
    await Deno.writeTextFile(
      ".npmrc",
      [
        `//npm.pkg.github.com/:_authToken=${accessToken}`,
        `@${org}:registry=https://npm.pkg.github.com`,
      ].map((line) => line + "\n").join(""),
    );
    console.log(`- ${yellow(".npmrc")} 파일을 생성하였습니다.`);
  });

command.parse(Deno.args);

function getGitHubCliClientId() {
  // https://github.com/cli/cli/blob/trunk/internal/authflow/flow.go#L18-L23
  return "178c6fc778ccc68e1d6a";
}

function getDeviceInitUrl(host: string) {
  return `https://${host}/login/device/code`;
}
function getTokenUrl(host: string) {
  return `https://${host}/login/oauth/access_token`;
}

interface RequestCodeResult {
  deviceCode: string;
  expiresIn: number;
  interval: number;
  userCode: string;
  verificationUri: string;
}
async function requestCode(): Promise<RequestCodeResult> {
  const res = await fetch(getDeviceInitUrl("github.com"), {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      client_id: getGitHubCliClientId(),
      scope: "read:packages",
    }),
  });
  const resText = await res.text();
  const parsedRes = new URLSearchParams(resText);
  return {
    deviceCode: parsedRes.get("device_code") ?? "",
    expiresIn: Number(parsedRes.get("expires_in")),
    interval: Number(parsedRes.get("interval")),
    userCode: parsedRes.get("user_code") ?? "",
    verificationUri: parsedRes.get("verification_uri") ?? "",
  };
}

interface PollTokenResponse {
  accessToken: string;
  tokenType: string;
  scope: string;
}
async function pollToken(
  code: RequestCodeResult,
): Promise<PollTokenResponse> {
  const { interval } = code;
  const startDate = new Date();
  const expireDate = new Date(startDate);
  expireDate.setSeconds(
    startDate.getSeconds() + code.expiresIn,
  );
  const loading = spinner("깃헙 인증을 기다리는 중입니다...").start();
  while (true) {
    await wait(interval * 1000);
    try {
      const res = await fetch(getTokenUrl("github.com"), {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          client_id: getGitHubCliClientId(),
          device_code: code.deviceCode,
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        }),
      });
      const resText = await res.text();
      const parsedRes = new URLSearchParams(resText);
      const resError = parsedRes.get("error");
      if (resError) {
        throw new Error(resError);
      }
      loading.stop();
      return {
        accessToken: parsedRes.get("access_token") ?? "",
        tokenType: parsedRes.get("token_type") ?? "",
        scope: parsedRes.get("scope") ?? "",
      };
    } catch (err) {
      if (err.message !== "authorization_pending") {
        loading.stop();
        throw err;
      }
    }
  }
}

async function open(url: string) {
  return await Deno.run({
    cmd: [...await getBrowserCmds(Deno.build.os), url],
  }).status();
}

async function getBrowserCmds(
  browser: typeof Deno["build"]["os"],
): Promise<string[]> {
  if (browser === "darwin") return ["open"];
  if (browser === "windows") return ["cmd", "/c", "start"];
  return [
    await which("xdg-open") ??
      await which("x-www-browser") ??
      await which("wslview") ??
      "sensible-browser",
  ];
}

async function which(command: string): Promise<string | null> {
  const pathEnv = Deno.env.get("PATH") ?? "";
  const pathExtEnv = Deno.env.get("PATHEXT");
  const paths = pathEnv.split(path.delimiter);
  const pathExts = pathExtEnv
    ? pathExtEnv.split(path.delimiter).concat("")
    : [""];
  for (const dir of paths) {
    for (const ext of pathExts) {
      const absolutePath = path.resolve(dir, command + ext);
      if (await exists(absolutePath)) return absolutePath;
    }
  }
  return null;
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function print(text: string): Promise<void> {
  await Deno.stdout.write(new TextEncoder().encode(text));
}
