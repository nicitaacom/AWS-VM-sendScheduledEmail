import VMModule from 'vm2';
const { VM } = VMModule;


import Redis from 'ioredis';
import moment from 'moment-timezone';
import { SESClient, SendEmailCommand } from "@aws-sdk/client-ses";

import { createClient } from "@supabase/supabase-js"
import { SchedulerClient, DeleteScheduleCommand } from "@aws-sdk/client-scheduler";
import crypto from "crypto"



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

  

if (!process.env.NEXT_PUBLIC_PRODUCTION_URL || !process.env.NEXT_PUBLIC_PRODUCTION_AUTH_URL) {
   return {
    statusCode: 400,
    error: 'NEXT_PUBLIC_PRODUCTION_URL or NEXT_PUBLIC_PRODUCTION_AUTH_URL missing',
  } 
}




const response = await fetch(`${process.env.NEXT_PUBLIC_PRODUCTION_AUTH_URL}api/lambda/VM-sendScheduledEmail`, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "X-Forwarded-For": process.env.NEXT_PUBLIC_PRODUCTION_URL!, // Non-null assertion, validated above
  },
  cache: "no-cache", // Should be no cache to improve security
});

if (!response.ok) {
  const errorMessage = await response.text(); // Get the error message from the response body
  throw new Error(`Error ${response.status}: ${errorMessage || "Unknown error"}`);
}

const responseData = await response.json();


const imports = {
  moment,
  Redis,
  SESClient,
  SendEmailCommand,
  createClient,
  SchedulerClient,
  DeleteScheduleCommand,
  crypto,
}


const vm = new VM({
  timeout: 25000, // 25 seconds to prevent Lambda timeout
  sandbox: {
    process: {
      env: {...process.env},
    },
    fetch, // Pass fetch to the sandbox
    event, // Pass the event to the VM sandbox
    imports
  },
});

try {
 
  // Make sure that responseData.code it's a index.js file that comes as a result of "tsc" command with "ESNext" in tsconfig.json
  const transformedCode = responseData.code
  // Remove the export handler function line, adjusting to potentially varying spaces
  .replace("export const handler = async (event) => {", '') // Remove handler definition line
  .replace("};", ''); // Remove only the last closing `};`


 const wrappedCode = `  
  const {  moment,Redis, SESClient, SendEmailCommand, createClient, SchedulerClient, DeleteScheduleCommand, crypto } = imports;

  (async () => {
    try {
      const result = await (async () => { 
        ${transformedCode} 
      })();

      if (result?.statusCode !== 200) {
        throw new Error(result.body);
      }

      return result;
    } catch (error) {
      const cleanErrorMessage = error.message.replace(/\\n/g, "\n").replace(/\\/g, '').replace(/\\/g, '');
      return { statusCode: 400, body: cleanErrorMessage };
    }
  })();
`;
    
 


  // Execute the wrapped code in the VM
  const result = await vm.run(wrappedCode);

  return {
    statusCode: 200,
    body: JSON.stringify(result),
  }
} catch (error) {
  const errorMessage: string = (error as Error)?.message || 'An unexpected error occurred';
  console.error('Error executing code in VM:', errorMessage);
  return {
    statusCode: 500,
    body: JSON.stringify({
      error: 'Failed to execute the code for VM-sendScheduledEmail',
      details: errorMessage,
    }),
  }
  }
};