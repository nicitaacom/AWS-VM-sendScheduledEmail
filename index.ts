import VMModule from 'vm2';
const { VM } = VMModule;

import { Resend } from 'resend' // if env notification group is Email

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


// DO NOT use this function in VM - for some reason it work with resend but doesn't work with redis
// I tried to change environment from node 22 to node 20 and ask chatGPT - useless
async function decryptResend(encryptedResendEnvValue:string) {
  try {
    // Define encoder and decoder - these were missing in your original code
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();
    
    const secretKey = JSON.stringify({
      secret: "DB",
      provider: "resend",
      APIKey: "someAPIKeyHere",
    })

    // Decode base64 to Uint8Array
    const encryptedData = Buffer.from(encryptedResendEnvValue, "base64")

    // Extract the salt, iv, and encrypted content
    const salt = encryptedData.slice(0, 16)
    const iv = encryptedData.slice(16, 28)
    const encrypted = encryptedData.slice(28)

    const keyMaterial = await crypto.subtle.importKey("raw", encoder.encode(secretKey), { name: "PBKDF2" }, false, [
      "deriveKey",
    ])

    // Derive the key
    const key = await crypto.subtle.deriveKey(
      {
        name: "PBKDF2",
        salt: salt,
        iterations: 310,
        hash: "SHA-256",
      },
      keyMaterial,
      { name: "AES-GCM", length: 256 },
      false,
      ["decrypt"],
    )

    // Decrypt the data
    const decrypted = await crypto.subtle.decrypt({ name: "AES-GCM", iv: iv }, key, encrypted)

    // Parse the decrypted data as JSON to extract key-value object
    const decodedText = decoder.decode(decrypted)
    const result = JSON.parse(decodedText)

    // Ensure the object contains only key and value fields
    if (Object.keys(result).length !== 2 || !('key' in result) || !('value' in result)) {
      return "error: decrypted object must contain only key and value fields"
    }

    return { key: result.key, value: result.value }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "An unknown error occurred during decryption."
    return `Decryption failed: ${errorMessage}`
  }
}


// DO NOT use this function in VM - for some reason it work with resend but doesn't work with redis
// I tried to change environment from node 22 to node 20 and ask chatGPT - useless
async function decryptRedis(encrypted:string, scheduledEmailsKey:string) {
  if (typeof window === "undefined") {
    try {

      const encoder = new TextEncoder()
      const decoder = new TextDecoder()


      // Define the fixed secret key for decryption
      const secretKey = JSON.stringify({
        secret: "DB",
        provider: "redis",
        APIKey: "some-api-key",
        scheduledEmailsKey
      })

      // Convert the Base64-encoded string back to a Uint8Array
      const combined = Buffer.from(encrypted, "base64");


      // Extract salt, IV, and ciphertext from the combined array
     const salt = Uint8Array.from(combined.slice(0, 16));
     const iv = combined.slice(16, 28);
     const ciphertext = combined.slice(28);


  

      // Create key material for PBKDF2
      const keyMaterial = await crypto.subtle.importKey("raw",encoder.encode(secretKey),{ name: "PBKDF2" },false,[
        "deriveKey"
      ]);
  
      // Derive the decryption key using PBKDF2
      const key = await crypto.subtle.deriveKey(
        {
          name: "PBKDF2",
          salt: salt,
          iterations: 310,
          hash: "SHA-256",
        },
        keyMaterial,
        { name: "AES-GCM", length: 256 },
        false,
        ["decrypt"]
      );

      // Decrypt the ciphertext
      const decrypted = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv },
        key,
        ciphertext
      );

      // Return the decrypted plaintext as a string
      return [decoder.decode(decrypted)]
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "An unknown error occurred during decryption.";
      return `Decryption failed: ${errorMessage}`
    }
  }
  return "This function must be run on the server."
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



const encoder = new TextEncoder()
const decoder = new TextDecoder()


const imports = {
  moment,
  Redis,
  SESClient,
  SendEmailCommand,
  createClient,
  SchedulerClient,
  DeleteScheduleCommand,
  crypto, // required to decryptResend (if env notification group is Email) 
  encoder, // required to decryptResend (if env notification group is Email)
  decoder, // required to decryptResend (if env notification group is Email)
  Resend, // required to send email (if env notification group is Email)
  decryptRedis,
  decryptResend
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
  const { moment, Redis, SESClient, SendEmailCommand, createClient, SchedulerClient, DeleteScheduleCommand,
  crypto, encoder, decoder, Resend, decryptRedis, decryptResend } = imports;

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
  let errorResponse: Record<string, any> = {
    statusCode: 500,
    error: 'Failed to execute the code for VM-sendScheduledEmail'
  };
  
  // Handle error response
  if (result) {
    // Copy all properties from result
    Object.keys(result).forEach((key: string) => {
      errorResponse[key] = result[key];
    });
  }
  
  return errorResponse;

} catch (error: unknown) {
  console.error('Error executing code in VM:', error);
  
  // Create base error response
  const errorResponse: Record<string, any> = {
    statusCode: 500,
    error: 'Failed to execute the code for VM-sendScheduledEmail'
  };
  
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