import VMModule from 'vm2';
const { VM } = VMModule;

import crypto from "crypto"

import Redis from 'ioredis';
import moment from 'moment-timezone';
import { SESClient, SendRawEmailCommand } from "@aws-sdk/client-ses";
import { SchedulerClient, DeleteScheduleCommand } from "@aws-sdk/client-scheduler";
import { createClient } from "@supabase/supabase-js"



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
  SendRawEmailCommand,
  createClient,
  SchedulerClient,
  DeleteScheduleCommand,
  crypto,
  setTimeout
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
    .replace("};", ''); // Remove only the last closing `}`;

  
    
  const wrappedCode = `  
  const { moment, Redis ,SESClient, SendRawEmailCommand, createClient, SchedulerClient, DeleteScheduleCommand, crypto,
   setTimeout } = imports;

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
  `
    
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
  let errorResponse: Record<string, any> = {
    statusCode: 500,
    error: 'Failed to execute the code for VM-sendScheduledEmail'
  }
  
  // Handle error response
  if (result) {
    // Copy all properties from result
    Object.keys(result).forEach((key: string) => {
      errorResponse[key] = result[key]
    })
  }
  
  return errorResponse;

  } catch (error: unknown) {
    console.error('Error executing code in VM:', error);
    
    // Create base error response
    const errorResponse: Record<string, any> = {
      statusCode: 500,
      error: 'Failed to execute the code for VM-sendScheduledEmail'
    }
    
    // Format error message
    if ((error as Error)?.message) {
      const messageLines = (error as Error).message.split('\n');
      errorResponse.errorSummary = messageLines[0];
      
      messageLines.slice(1).forEach((line: string, idx: number) => {
        if (line.trim()) {
          errorResponse[`errorInfo${idx + 1}`] = line.trim();
        }
      });
    }
    
    // Format stack trace
    if ((error as Error)?.stack) {
      const stackLines = (error as Error).stack!.split('\n');
      stackLines.forEach((line: string, idx: number) => {
        errorResponse[`stackInfo${idx + 1}`] = line.trim();
      });
    }
    
    return errorResponse;
  }
};