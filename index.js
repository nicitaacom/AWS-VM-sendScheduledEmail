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
            fetch,
            event,
            imports
        },
    });
    try {
        // Make sure that responseData.code it's a index.js file that comes as a result of "tsc" command with "ESNext" in tsconfig.json
        const transformedCode = responseData.code
            // Remove the export handler function line, adjusting to potentially varying spaces
            .replace("export const handler = async (event) => {", '') // Remove handler definition line
            .replace("};", ''); // Remove only the last closing `}`;
        const wrappedCode = `  
  const { moment, Redis ,SESClient, SendRawEmailCommand, createClient, SchedulerClient, DeleteScheduleCommand, freeEmailDomains } = imports;

  (async () => {
    try {
      const result = await (async () => { 
        ${transformedCode} 
      })();
      return result;
    } catch (error) {
      const errorResponse = {
        statusCode: 500,
        error: 'Failed to execute the code for VM-sendScheduledEmail'
      };
      
      if (error.message) {
        const lines = error.message.split('\\n');
        errorResponse.errorSummary = lines[0];
        
        lines.slice(1).forEach((line, idx) => {
          if (line.trim()) {
            errorResponse['errorInfo' + (idx + 1)] = line.trim();
          }
        });
      }
      
      if (error.stack) {
        const stackLines = error.stack.split('\\n');
        stackLines.forEach((line, idx) => {
          errorResponse['stackInfo' + (idx + 1)] = line.trim();
        });
      }
      
      return errorResponse;
    }
  })();
  `;
        // Execute the wrapped code in the VM
        const result = await vm.run(wrappedCode);
        // Handle successful result
        if (result?.statusCode === 200) {
            return {
                statusCode: 200,
                ...result
            };
        }
        // Format error stack if available
        let errorResponse = {
            statusCode: 500,
            error: 'Failed to execute the code for VM-sendScheduledEmail'
        };
        // Handle error response
        if (result) {
            // Copy all properties from result
            Object.keys(result).forEach((key) => {
                errorResponse[key] = result[key];
            });
        }
        return errorResponse;
    }
    catch (error) {
        console.error('Error executing code in VM:', error);
        // Create base error response
        const errorResponse = {
            statusCode: 500,
            error: 'Failed to execute the code for VM-sendScheduledEmail'
        };
        // Format error message
        if (error?.message) {
            const messageLines = error.message.split('\n');
            errorResponse.errorSummary = messageLines[0];
            messageLines.slice(1).forEach((line, idx) => {
                if (line.trim()) {
                    errorResponse[`errorInfo${idx + 1}`] = line.trim();
                }
            });
        }
        // Format stack trace
        if (error?.stack) {
            const stackLines = error.stack.split('\n');
            stackLines.forEach((line, idx) => {
                errorResponse[`stackInfo${idx + 1}`] = line.trim();
            });
        }
        return errorResponse;
    }
};
exports.handler = handler;
