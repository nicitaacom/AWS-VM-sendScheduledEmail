"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.handler = void 0;
const vm2_1 = __importDefault(require("vm2"));
const { VM } = vm2_1.default;
const resend_1 = require("resend"); // if env notification group is Email
const ioredis_1 = __importDefault(require("ioredis"));
const moment_timezone_1 = __importDefault(require("moment-timezone"));
const client_ses_1 = require("@aws-sdk/client-ses");
const supabase_js_1 = require("@supabase/supabase-js");
const client_scheduler_1 = require("@aws-sdk/client-scheduler");
const crypto_1 = __importDefault(require("crypto"));
// DO NOT use this function in VM - for some reason it work with resend but doesn't work with redis
// I tried to change environment from node 22 to node 20 and ask chatGPT - useless
async function decryptResend(encryptedResendEnvValue) {
    try {
        // Define encoder and decoder - these were missing in your original code
        const encoder = new TextEncoder();
        const decoder = new TextDecoder();
        const secretKey = JSON.stringify({
            secret: "DB",
            provider: "resend",
            APIKey: "someAPIKeyHere",
        });
        // Decode base64 to Uint8Array
        const encryptedData = Buffer.from(encryptedResendEnvValue, "base64");
        // Extract the salt, iv, and encrypted content
        const salt = encryptedData.slice(0, 16);
        const iv = encryptedData.slice(16, 28);
        const encrypted = encryptedData.slice(28);
        const keyMaterial = await crypto_1.default.subtle.importKey("raw", encoder.encode(secretKey), { name: "PBKDF2" }, false, [
            "deriveKey",
        ]);
        // Derive the key
        const key = await crypto_1.default.subtle.deriveKey({
            name: "PBKDF2",
            salt: salt,
            iterations: 310,
            hash: "SHA-256",
        }, keyMaterial, { name: "AES-GCM", length: 256 }, false, ["decrypt"]);
        // Decrypt the data
        const decrypted = await crypto_1.default.subtle.decrypt({ name: "AES-GCM", iv: iv }, key, encrypted);
        // Parse the decrypted data as JSON to extract key-value object
        const decodedText = decoder.decode(decrypted);
        const result = JSON.parse(decodedText);
        // Ensure the object contains only key and value fields
        if (Object.keys(result).length !== 2 || !('key' in result) || !('value' in result)) {
            return "error: decrypted object must contain only key and value fields";
        }
        return { key: result.key, value: result.value };
    }
    catch (error) {
        const errorMessage = error instanceof Error ? error.message : "An unknown error occurred during decryption.";
        return `Decryption failed: ${errorMessage}`;
    }
}
// DO NOT use this function in VM - for some reason it work with resend but doesn't work with redis
// I tried to change environment from node 22 to node 20 and ask chatGPT - useless
async function decryptRedis(encrypted, scheduledEmailsKey) {
    if (typeof window === "undefined") {
        try {
            const encoder = new TextEncoder();
            const decoder = new TextDecoder();
            // Define the fixed secret key for decryption
            const secretKey = JSON.stringify({
                secret: "DB",
                provider: "redis",
                APIKey: "some-api-key",
                scheduledEmailsKey
            });
            // Convert the Base64-encoded string back to a Uint8Array
            const combined = Buffer.from(encrypted, "base64");
            // Extract salt, IV, and ciphertext from the combined array
            const salt = Uint8Array.from(combined.slice(0, 16));
            const iv = combined.slice(16, 28);
            const ciphertext = combined.slice(28);
            // Create key material for PBKDF2
            const keyMaterial = await crypto_1.default.subtle.importKey("raw", encoder.encode(secretKey), { name: "PBKDF2" }, false, [
                "deriveKey"
            ]);
            // Derive the decryption key using PBKDF2
            const key = await crypto_1.default.subtle.deriveKey({
                name: "PBKDF2",
                salt: salt,
                iterations: 310,
                hash: "SHA-256",
            }, keyMaterial, { name: "AES-GCM", length: 256 }, false, ["decrypt"]);
            // Decrypt the ciphertext
            const decrypted = await crypto_1.default.subtle.decrypt({ name: "AES-GCM", iv }, key, ciphertext);
            // Return the decrypted plaintext as a string
            return [decoder.decode(decrypted)];
        }
        catch (error) {
            const errorMessage = error instanceof Error ? error.message : "An unknown error occurred during decryption.";
            return `Decryption failed: ${errorMessage}`;
        }
    }
    return "This function must be run on the server.";
}
const handler = async (event) => {
    if (!process.env.NEXT_PUBLIC_PRODUCTION_URL || !process.env.NEXT_PUBLIC_PRODUCTION_AUTH_URL) {
        return {
            statusCode: 400,
            error: 'NEXT_PUBLIC_PRODUCTION_URL or NEXT_PUBLIC_PRODUCTION_AUTH_URL missing',
        };
    }
    const response = await fetch(`${process.env.NEXT_PUBLIC_PRODUCTION_AUTH_URL}api/lambda/VM-sendScheduledEmail`, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "X-Forwarded-For": process.env.NEXT_PUBLIC_PRODUCTION_URL, // Non-null assertion, validated above
        },
        cache: "no-cache", // Should be no cache to improve security
    });
    if (!response.ok) {
        const errorMessage = await response.text(); // Get the error message from the response body
        throw new Error(`Error ${response.status}: ${errorMessage || "Unknown error"}`);
    }
    const responseData = await response.json();
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();
    const imports = {
        moment: moment_timezone_1.default,
        Redis: ioredis_1.default,
        SESClient: client_ses_1.SESClient,
        SendEmailCommand: client_ses_1.SendEmailCommand,
        createClient: supabase_js_1.createClient,
        SchedulerClient: client_scheduler_1.SchedulerClient,
        DeleteScheduleCommand: client_scheduler_1.DeleteScheduleCommand,
        crypto: crypto_1.default,
        encoder,
        decoder,
        Resend: // required to decryptResend (if env notification group is Email)
        resend_1.Resend,
        decryptRedis,
        decryptResend
    };
    const vm = new VM({
        timeout: 25000,
        sandbox: {
            process: {
                env: { ...process.env },
            },
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
            .replace("};", ''); // Remove only the last closing `};`
        const wrappedCode = `  
  const { moment, Redis, SESClient, SendEmailCommand, createClient, SchedulerClient, DeleteScheduleCommand,
  crypto, encoder, decoder, Resend,
  decryptRedis, decryptResend } = imports;

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
      return { statusCode: 400, body: error.message };
    }
  })();
`;
        // Execute the wrapped code in the VM
        const result = await vm.run(wrappedCode);
        if (result?.statusCode !== 200) {
            const cleanedError = result.body.replace(/\\n/g, "\n").replace(/\\/g, '').replace(/\\/g, '');
            throw new Error(cleanedError);
        }
        return {
            statusCode: 200,
            body: JSON.stringify(result),
        };
    }
    catch (error) {
        const errorMessage = error?.message || 'An unexpected error occurred';
        console.error('Error executing code in VM:', errorMessage);
        // NOTE: Do error handling with notifications IN auth server because in that way I can add new notification group
        return {
            statusCode: 500,
            body: JSON.stringify({
                error: 'Failed to execute the code for VM-sendScheduledEmail',
                details: errorMessage,
            }),
        };
    }
};
exports.handler = handler;
