"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.handler = void 0;
const vm2_1 = __importDefault(require("vm2"));
const { VM } = vm2_1.default;
const ioredis_1 = __importDefault(require("ioredis"));
const moment_timezone_1 = __importDefault(require("moment-timezone"));
const client_ses_1 = require("@aws-sdk/client-ses");
const client_scheduler_1 = require("@aws-sdk/client-scheduler");
const supabase_js_1 = require("@supabase/supabase-js");
// Node related
const buffer_1 = require("buffer");
const url_1 = require("url");
const url_2 = require("url");
// For freeEmailDomains - so I fetch from entiryRedis envs by correct userId (if sent from gmail cuz user.email domain might be ukr.net)
const fs_1 = require("fs");
const path_1 = __importDefault(require("path"));
const NEXT_PUBLIC_PRODUCTION_URL = "https://www.outreach-tool.com/";
const NEXT_PUBLIC_PRODUCTION_AUTH_URL = "https://auth.outreach-tool.com/";
const handler = async (event) => {
    if (!NEXT_PUBLIC_PRODUCTION_URL || !NEXT_PUBLIC_PRODUCTION_AUTH_URL) {
        return {
            statusCode: 400,
            error: 'NEXT_PUBLIC_PRODUCTION_URL or NEXT_PUBLIC_PRODUCTION_AUTH_URL missing',
        };
    }
    const response = await fetch(`${NEXT_PUBLIC_PRODUCTION_AUTH_URL}api/lambda/VM-sendScheduledEmail`, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "X-Forwarded-For": NEXT_PUBLIC_PRODUCTION_URL,
        },
        cache: "no-cache", // Should be no cache to improve security
    });
    if (!response.ok) {
        const errorMessage = await response.text(); // Get the error message from the response body
        throw new Error(`Error ${response.status}: ${errorMessage || "Unknown error"}`);
    }
    const responseData = await response.json();
    // 📁 Works because CommonJS has __dirname by default
    const filePath = path_1.default.join(__dirname, "freeEmailList.txt");
    const freeEmailDomains = (0, fs_1.readFileSync)(filePath, "utf-8")
        .split("\n")
        .map(domain => domain.trim().toLowerCase())
        .filter(Boolean); // remove empty lines
    const imports = {
        moment: moment_timezone_1.default,
        Redis: ioredis_1.default,
        SESClient: client_ses_1.SESClient,
        SendRawEmailCommand: client_ses_1.SendRawEmailCommand,
        createClient: supabase_js_1.createClient,
        SchedulerClient: client_scheduler_1.SchedulerClient,
        DeleteScheduleCommand: client_scheduler_1.DeleteScheduleCommand,
        freeEmailDomains
    };
    const vm = new VM({
        timeout: 80000,
        sandbox: {
            process: {
                env: { ...process.env },
            },
            // Node related
            setTimeout,
            Buffer: buffer_1.Buffer,
            URLSearchParams: // required for twilio Authorization token
            url_1.URLSearchParams,
            URL: url_2.URL,
            fetch,
            event,
            imports
        },
    });
    // Make sure that responseData.code it's a index.js file that comes as a result of "tsc" command with "ESNext" in tsconfig.json
    const transformedCode = responseData.code
        // Remove the export handler function line, adjusting to potentially varying spaces
        .replace("export const handler = async (event) => {", '') // Remove handler definition line
        .replace("};", ''); // Remove only the last closing `}`;
    // 1. extract ALL needed debug helpers with better regex
    const debugConstMatch = transformedCode.match(/const DEBUG_DISCORD_WEBHOOK_URL\s*=\s*"([^"]+)"/);
    const truncateMatch = transformedCode.match(/const truncateLongFields\s*=\s*\(errorMessage\)\s*=>\s*\{[\s\S]*?return JSON\.stringify\(parsed\)\s*\}/);
    const validateMatch = transformedCode.match(/const validateParsedError\s*=\s*\(parsed\)\s*=>\s*[\s\S]*?typeof parsed\.lambdaFnName === "string"/);
    const getErrorInfoMatch = transformedCode.match(/const getErrorInfo\s*=\s*\(errorMessage\)\s*=>\s*\{[\s\S]*?return \{ lambdaFnName, cause, formattedTime, processedMessage, parsingError \}\s*\}/);
    const sendFnMatch = transformedCode.match(/const sendDiscordDebugMessage\s*=\s*async\s*\(errorMessage\)\s*=>\s*\{[\s\S]*?return true\s*\}/);
    const getPartsFnMatch = transformedCode.match(/const getDiscordMessageParts\s*=\s*\(processedMessage,\s*headerLines(?:,\s*note)?\)\s*=>\s*\{[\s\S]*?return messageParts\s*\}/);
    const wrappedCode = `  
  const { moment, Redis ,SESClient, SendRawEmailCommand, createClient, SchedulerClient, DeleteScheduleCommand, freeEmailDomains } = imports;

  // do not wrap it in try catch - otherwise you would just return statusCode: 500 so vm.run() RESOLVES (not rejects) with statusCode: 500
  // so it means if it not rejected - .catch block never reached - means no dis debug msg sent
  (async () => {
    const result = await (async () => { 
      ${transformedCode} 
    })();
    return result;
  })();
  `;
    return vm.run(wrappedCode)
        .then((vm2Resp) => vm2Resp?.statusCode === 200
        ? { statusCode: 200, ...vm2Resp }
        : { statusCode: 500, ...vm2Resp })
        .catch(async (error) => {
        const errMsg = error instanceof Error ? error.message : String(error);
        if (debugConstMatch && truncateMatch && validateMatch && getErrorInfoMatch && sendFnMatch && getPartsFnMatch) {
            const debugCode = `
          ${debugConstMatch[0]};
          ${truncateMatch[0]};
          ${validateMatch[0]};
          ${getErrorInfoMatch[0]};
          ${sendFnMatch[0]};
          ${getPartsFnMatch[0]};
          await sendDiscordDebugMessage(\`VM runtime error in transformedCode: ${errMsg.replace(/`/g, '\\`').replace(/\n/g, '\\n')}\`)
        `;
            try {
                await vm.run(`(async () => { ${debugCode} })()`);
                console.log(251, 'debug message sent to discord');
            }
            catch (debugErr) {
                const debugMessage = debugErr instanceof Error ? debugErr.message : String(debugErr);
                console.log(250, 'debug send failed too:', debugMessage);
            }
        }
        return {
            statusCode: 500,
            error: 'Failed to execute the code for VM-sendScheduledEmail',
            message: errMsg,
        };
    });
};
exports.handler = handler;
