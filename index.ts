import VMModule from 'vm2';
const { VM } = VMModule;

import Redis from 'ioredis';
import moment from 'moment-timezone';
import { SESClient, SendRawEmailCommand } from "@aws-sdk/client-ses";
import { SchedulerClient, DeleteScheduleCommand } from "@aws-sdk/client-scheduler";
import { createClient } from "@supabase/supabase-js"


// Node related
import { Buffer } from "buffer"
import { URLSearchParams } from "url"
import { URL } from "url"


// For freeEmailDomains - so I fetch from entiryRedis envs by correct userId (if sent from gmail cuz user.email domain might be ukr.net)
import { readFileSync } from "fs"
import path from "path"


const NEXT_PUBLIC_PRODUCTION_URL = "https://www.outreach-tool.com/"
const NEXT_PUBLIC_PRODUCTION_AUTH_URL = "https://auth.outreach-tool.com/"


export interface IOriginalEmail {
  timestamp: string
  name: string
  from: string
  body: string
}


// Define the type for the event
interface Event {
  encryptedRedis:string,
  originalEmail?:IOriginalEmail,
  scheduledEmailsKey:string,
  idName:string,
  emailFrom:string,
  emailTo:string,
  initialEmailBody?:string,
  initialEmailImgUrl?:string,
  emailSubject:string,
  isUnsubscribeLink:boolean;
}







export const handler = async (event: Event) => {

  

if (!NEXT_PUBLIC_PRODUCTION_URL || !NEXT_PUBLIC_PRODUCTION_AUTH_URL) {
   return {
    statusCode: 400,
    error: 'NEXT_PUBLIC_PRODUCTION_URL or NEXT_PUBLIC_PRODUCTION_AUTH_URL missing',
  } 
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
  const filePath = path.join(__dirname, "freeEmailList.txt")

  const freeEmailDomains = readFileSync(filePath, "utf-8")
    .split("\n")
    .map(domain => domain.trim().toLowerCase())
    .filter(Boolean) // remove empty lines

  


const imports = {
  moment,
  Redis,
  SESClient,
  SendRawEmailCommand,
  createClient,
  SchedulerClient,
  DeleteScheduleCommand,
  freeEmailDomains
}



const vm = new VM({
  timeout: 80000, // 80 seconds to prevent Lambda timeout (60s for delay - 20s for execution)
  sandbox: {
    process: {
      env: {...process.env},
    },
      // Node related
      setTimeout,
      Buffer, // required for twilio Authorization token
      URLSearchParams,
      URL,
      fetch, // Pass fetch to the sandbox

      event, // Pass the event to the VM sandbox
      imports
  },
});

 
  // Make sure that responseData.code it's a index.js file that comes as a result of "tsc" command with "ESNext" in tsconfig.json
  const transformedCode = responseData.code
    // Remove the export handler function line, adjusting to potentially varying spaces
    .replace("export const handler = async (event) => {", '') // Remove handler definition line
    .replace("};", ''); // Remove only the last closing `}`;

    // 1. extract ALL needed debug helpers with better regex
    const debugConstMatch = transformedCode.match(/const DEBUG_DISCORD_WEBHOOK_URL\s*=\s*"([^"]+)"/)
    const truncateMatch = transformedCode.match(/const truncateLongFields\s*=\s*\(errorMessage\)\s*=>\s*\{[\s\S]*?return JSON\.stringify\(parsed\)\s*\}/)
    const validateMatch = transformedCode.match(/const validateParsedError\s*=\s*\(parsed\)\s*=>\s*[\s\S]*?typeof parsed\.lambdaFnName === "string"/)
    const getErrorInfoMatch = transformedCode.match(/const getErrorInfo\s*=\s*\(errorMessage\)\s*=>\s*\{[\s\S]*?return \{ lambdaFnName, cause, formattedTime, processedMessage, parsingError \}\s*\}/)
    const sendFnMatch = transformedCode.match(/const sendDiscordDebugMessage\s*=\s*async\s*\(errorMessage\)\s*=>\s*\{[\s\S]*?return true\s*\}/)
    const getPartsFnMatch = transformedCode.match(/const getDiscordMessageParts\s*=\s*\(processedMessage,\s*headerLines(?:,\s*note)?\)\s*=>\s*\{[\s\S]*?return messageParts\s*\}/)

  
    
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
  `
    
  return vm.run(wrappedCode)
    .then((vm2Resp: any) => vm2Resp?.statusCode === 200 
      ? { statusCode: 200, ...vm2Resp }
      : { statusCode: 500, ...vm2Resp })
    .catch(async (error: unknown) => {
      const errMsg = error instanceof Error ? error.message : String(error)

      if (debugConstMatch && truncateMatch && validateMatch && getErrorInfoMatch && sendFnMatch && getPartsFnMatch) {
        const debugCode = `
          ${debugConstMatch[0]};
          ${truncateMatch[0]};
          ${validateMatch[0]};
          ${getErrorInfoMatch[0]};
          ${sendFnMatch[0]};
          ${getPartsFnMatch[0]};
          await sendDiscordDebugMessage(\`VM runtime error in transformedCode: ${errMsg.replace(/`/g, '\\`').replace(/\n/g, '\\n')}\`)
        `
        try {
          await vm.run(`(async () => { ${debugCode} })()`)
          console.log(251, 'debug message sent to discord')
        } catch (debugErr) {
          const debugMessage = debugErr instanceof Error ? debugErr.message : String(debugErr)
          console.log(250, 'debug send failed too:', debugMessage)
        }
      }

      return {
        statusCode: 500,
        error: 'Failed to execute the code for VM-sendScheduledEmail',
        message: errMsg,
      }
    })
}
