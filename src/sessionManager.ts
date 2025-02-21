import { RawData, WebSocket } from "ws";
import functions from "./functionHandlers";
import { systemPrompt } from "./systeminstructions";
const alawmulaw = require('alawmulaw');
interface Session {
  twilioConn?: WebSocket;
  frontendConn?: WebSocket;
  modelConn?: WebSocket;
  streamSid?: string;
  saved_config?: any;
  lastAssistantItem?: string;
  responseStartTimestamp?: number;
  latestMediaTimestamp?: number;
  openAIApiKey?: string;
}
const Fili = require("fili")
let session: Session = {};
var iirCalculator = new Fili.CalcCascades();
// var firCalculator = new Fili.firCoeffs();
var iirFilterCoeffs = iirCalculator.lowpass({
  order: 3, // cascade 3 biquad filters (max: 5)
  characteristic: 'tschebyscheff3',
  transform: 'matchedZ',
  Fs: 16000, // sampling frequency
  Fc: 4800, // cutoff frequency / center frequency for bandpass, bandstop, peak
  preGain: true // uses k when true for gain correction b[0] otherwise
});
var firFilterCoeffs = iirCalculator.highpass({
  order: 3, // cascade 3 biquad filters (max: 12)
  characteristic: 'butterworth',
  Fs: 16000, // sampling frequency
  Fc: 400, // cutoff frequency / center frequency for bandpass, bandstop, peak
  BW: 1, // bandwidth only for bandstop and bandpass filters - optional
  gain: 20, // gain for peak, lowshelf and highshelf
  preGain: true // adds one constant multiplication for highpass and lowpass
  // k = (1 + cos(omega)) * 0.5 / k = 1 with
});

// filter coefficients by Kaiser-Bessel window

// create a filter instance from the calculated coeffs
var firFilter = new Fili.IirFilter(firFilterCoeffs);
// create a filter instance from the calculated coeffs
var iirFilter = new Fili.IirFilter(iirFilterCoeffs);
export function handleCallConnection(ws: WebSocket, openAIApiKey: string) {
  cleanupConnection(session.twilioConn);
  session.twilioConn = ws;
  session.openAIApiKey = openAIApiKey;
  // ws.on("*", (event) => {console.log(event)});
  ws.on("message", handleTwilioMessage);
  ws.on("error", ws.close);
  ws.on("close", () => {
    cleanupConnection(session.modelConn);
    cleanupConnection(session.twilioConn);
    session.twilioConn = undefined;
    session.modelConn = undefined;
    session.streamSid = undefined;
    session.lastAssistantItem = undefined;
    session.responseStartTimestamp = undefined;
    session.latestMediaTimestamp = undefined;
    if (!session.frontendConn) session = {};
  });
}

export function handleFrontendConnection(ws: WebSocket) {
  cleanupConnection(session.frontendConn);
  session.frontendConn = ws;

  ws.on("message", handleFrontendMessage);
  ws.on("close", () => {
    cleanupConnection(session.frontendConn);
    session.frontendConn = undefined;
    if (!session.twilioConn && !session.modelConn) session = {};
  });
}

async function handleFunctionCall(item: { name: string; arguments: string }) {
  console.log("Handling function call:", item);
  const fnDef = functions.find((f) => f.schema.name === item.name);
  if (!fnDef) {
    throw new Error(`No handler found for function: ${item.name}`);
  }

  let args: unknown;
  try {
    args = JSON.parse(item.arguments);
  } catch {
    return JSON.stringify({
      error: "Invalid JSON arguments for function call.",
    });
  }

  try {
    console.log("Calling function:", fnDef.schema.name, args);
    const result = await fnDef.handler(args as any);
    return result;
  } catch (err: any) {
    console.error("Error running function:", err);
    return JSON.stringify({
      error: `Error running function ${item.name}: ${err.message}`,
    });
  }
}

function handleTwilioMessage(data: RawData) {
  const msg = parseMessage(data);
  if (!msg) return;

  switch (msg.event) {
    case "start":
      session.streamSid = msg.start.streamSid;
      session.latestMediaTimestamp = 0;
      session.lastAssistantItem = undefined;
      session.responseStartTimestamp = undefined;
      tryConnectModel();
      break;
    case "media":
      session.latestMediaTimestamp = msg.media.timestamp;
      if (isOpen(session.modelConn)) {
        jsonSend(session.modelConn, {
          type: "input_audio_buffer.append",
          audio: msg.media.payload,
        });
      }
      break;
    case "close":
      closeAllConnections();
      break;
  }
}

function handleFrontendMessage(data: RawData) {
  const msg = parseMessage(data);
  if (!msg) return;

  if (isOpen(session.modelConn)) {
    jsonSend(session.modelConn, msg);
  }

  if (msg.type === "session.update") {
    console.log("Session update:", msg.session);
    session.saved_config = msg.session;
  }
}

function tryConnectModel() {
  if (!session.twilioConn || !session.streamSid || !session.openAIApiKey)
    return;
  if (isOpen(session.modelConn)) return;

  session.modelConn = new WebSocket(
    "wss://api.openai.com/v1/realtime?model=gpt-4o-mini-realtime-preview-2024-12-17",
    {
      headers: {
        Authorization: `Bearer ${session.openAIApiKey}`,
        "OpenAI-Beta": "realtime=v1",
      },
    }
  );

  session.modelConn.on("open", () => {
    const config = session.saved_config || {};
    console.log("Connected to OpenAI model:", config);
    jsonSend(session.modelConn, {
      type: "session.update",
      session: {
        modalities: ["text", "audio"],
        turn_detection: { type: "server_vad" },
        voice: "sage",
        input_audio_transcription: { model: "whisper-1" },
        input_audio_format: "g711_ulaw",
        output_audio_format: "g711_ulaw",
        temperature: 0.8,
        instructions: systemPrompt,
        ...config,
      },
    });
  });

  // session.modelConn.on("session.created", () => {
  //   console.log("Session created with OpenAI model.");
  //   jsonSend(session.modelConn, {
  //     type: "response.create",
  //     response: {
  //       instructions:
  //         "Introduce yourself as Sasha from Human Feedback and ask who is calling then how you can help them." + systemPrompt,
  //     },
  //   });
  // });

  // session.modelConn.on("*", (event) => {
  //   console.log("MDOEL EVENGT 163");
    // console.log("Model event:", event); 
    // console.log(event)});
  session.modelConn.on("message", handleModelMessage);
  session.modelConn.on("error", closeModel);
  session.modelConn.on("close", closeModel);
}

// g711_lowpass.ts

/**
 * Decode an 8-bit μ-law sample to a linear PCM value.
 * This implementation uses the common μ-law expansion algorithm.
 */
function ulawToLinear(ulaw: number): number {
  // Invert all bits and limit to 8 bits.
  ulaw = ~ulaw & 0xFF;
  const sign = (ulaw & 0x80) ? -1 : 1;
  const exponent = (ulaw >> 4) & 0x07;
  const mantissa = ulaw & 0x0F;
  // Bias constant (0x84 = 132) is used in many implementations.
  const bias = 0x84;
  // Expand the μ-law value to linear PCM.
  const sample = ((mantissa << 3) + bias) << exponent;
  return sign * sample;
}

/**
 * Encode a linear PCM sample back to 8-bit μ-law.
 * Note: There are several variants; this is one common approach.
 */
function linearToULaw(sample: number): number {
  const BIAS = 0x84;
  let sign = (sample < 0) ? 0x80 : 0;
  sample = Math.abs(sample);
  sample = sample + BIAS;
  // Clamp to maximum value.
  if (sample > 32635) sample = 32635;
  
  let exponent = 7;
  for (let expMask = 0x4000; (sample & expMask) === 0 && exponent > 0; expMask >>= 1) {
    exponent--;
  }
  const mantissa = (sample >> (exponent + 3)) & 0x0F;
  let ulawByte = ~(sign | (exponent << 4) | mantissa);
  return ulawByte & 0xFF;
}

/**
 * Compute the filter coefficient (alpha) for a single-pole IIR lowpass filter.
 * Uses the RC filter analogy.
 *
 * @param fc - cutoff frequency in Hz
 * @param fs - sampling rate in Hz
 */
function computeAlpha(fc: number, fs: number): number {
  const RC = 1 / (2 * Math.PI * fc);
  const dt = 1 / fs;
  return dt / (RC + dt);
}

/**
 * Apply a single-pole IIR lowpass filter to a sequence of linear PCM samples.
 *
 * y[n] = alpha * x[n] + (1 - alpha) * y[n-1]
 *
 * @param input - array of linear PCM samples
 * @param alpha - filter coefficient computed from fc and fs
 * @returns filtered PCM sample array
 */
function lowpassIIR(input: number[], alpha: number): Int16Array {
  const output: Int16Array = new Int16Array(input.length);
  output[0] = input[0];
  for (let i = 1; i < input.length; i++) {
    output[i] = alpha * input[i] + (1 - alpha) * output[i - 1];
  }
  return output;
}

/* ===== Example Usage ===== */

// Replace this array with your actual G.711 μ-law samples (values 0-255)
function amplifyPCM16Buffer(buffer: Int16Array, dbIncrease: number): void {
  // Convert dB increase to a multiplicative factor: factor = 10^(dB/20)
  const factor = Math.pow(10, dbIncrease / 20);
  
  for (let i = 0; i < buffer.length; i++) {
      let amplified = buffer[i] * factor;
      console.log("AMPLIFIED", amplified)
      // Clamp to the 16-bit signed integer range.
      if (amplified > 32767) {
          console.log("CLAMPING")
          amplified = 32767;
      } else if (amplified < -32768) {
          amplified = -32768;
      }
      
      buffer[i] = Math.round(amplified);
  }
}


function handleModelMessage(data: RawData) {
  const event = parseMessage(data);
  // console.log("Model event:", event);
  if (!event) return;

  jsonSend(session.frontendConn, event);

  switch (event.type) {
    case "input_audio_buffer.speech_started":
      handleTruncation();
      break;

    case "session.created":
      
      jsonSend(session.modelConn, {
        type: "response.create",
        response: {
          instructions:
            "You are an experienced and busy secratary dealing with large call volume, so speak quickly and concisely. Don't be too enthusiastic, Say the following with a professional tonality: 'Hello, this is Human Feedback HQ... how can I help you?'" + systemPrompt,
        },
      })

    case "response.audio.delta":
      if (session.twilioConn && session.streamSid) {
        if (session.responseStartTimestamp === undefined) {
          session.responseStartTimestamp = session.latestMediaTimestamp || 0;
        }
        if (event.item_id) session.lastAssistantItem = event.item_id;
        // if (!event.delta) break
        try {
          // 1. Convert base64 to buffer
          const audioBuffer = Buffer.from(event.delta, 'base64');
          
          // 2. Convert to array of µ-law samples
          const ulawSamples = Array.from(new Uint16Array(audioBuffer));
          // const ulawSamples = alawmulaw.mulaw.decode(event.delta);
          
          // // 3. Convert to PCM samples
          // // const pcmSamples = ulawSamples.map(ulawToLinear);
          // const pcmSamples = ulawSamples.map(sample => {
          //   return linearToULaw(sample);
          // });
          // 4. Apply much higher gain (increase volume significantly)
          
          // 5. Apply extremely minimal filtering
          const b1 = alawmulaw.mulaw.decode(ulawSamples);
          const gainFactor = 20.0; // Much higher gain boost
          // const amplifiedPCMSamples = b1.map((sample: any) => sample * gainFactor);
          const fs = 8000;
          const fcHigh = 3900;
          // const alphaHigh = computeAlpha(fcHigh, fs) * 0.3;
          // const filteredPCMSamples: Int16Array = lowpassIIR(b1, alphaHigh);
          const filteredPCMSamples = iirFilter.multiStep(b1);
          const filteredPCMSamples2 = firFilter.multiStep(filteredPCMSamples);
          // amplifyPCM16Buffer(filteredPCMSamples, gainFactor);
          // // 6. Convert back to µ-law with minimal noise reduction
          // const filteredULawSamples = ulawSamples.map(sample => {
          //   if (Math.abs(sample) < 10) {
          //     return 127;
          //   }
          //   return linearToULaw(sample);
          // });
            // console.log("ulawSamples", ulawSamples);
          // const filteredULawSamples = alawmulaw.mulaw.encode(ulawSamples);
          
          // const processedBuffer = Buffer.from(filteredULawSamples);




          const b2 = alawmulaw.mulaw.encode(filteredPCMSamples2);
          const processedBuffer = Buffer.from(b2);
          const processedBase64 = processedBuffer.toString('base64');
          // console.log("processedBase64", processedBase64);

          jsonSend(session.twilioConn, {
            event: "media",
            streamSid: session.streamSid,
            media: { 
              payload: processedBase64
            },
          });
          
          jsonSend(session.twilioConn, {
            event: "mark",
            streamSid: session.streamSid,
          });

        } catch (error) {
          console.error('Error processing audio data:', error);
          console.error('Event delta length:', event.delta?.length);
        }
      }
      break;

    case "response.output_item.done": {
      const { item } = event;
      if (item.type === "function_call") {
        handleFunctionCall(item)
          .then((output) => {
            if (session.modelConn) {
              jsonSend(session.modelConn, {
                type: "conversation.item.create",
                item: {
                  type: "function_call_output",
                  call_id: item.call_id,
                  output: JSON.stringify(output),
                },
              });
              jsonSend(session.modelConn, { type: "response.create" });
            }
          })
          .catch((err) => {
            console.error("Error handling function call:", err);
          });
      }
      break;
    }
  }
}

function handleTruncation() {
  if (
    !session.lastAssistantItem ||
    session.responseStartTimestamp === undefined
  )
    return;

  const elapsedMs =
    (session.latestMediaTimestamp || 0) - (session.responseStartTimestamp || 0);
  const audio_end_ms = elapsedMs > 0 ? elapsedMs : 0;

  if (isOpen(session.modelConn)) {
    jsonSend(session.modelConn, {
      type: "conversation.item.truncate",
      item_id: session.lastAssistantItem,
      content_index: 0,
      audio_end_ms,
    });
  }

  if (session.twilioConn && session.streamSid) {
    jsonSend(session.twilioConn, {
      event: "clear",
      streamSid: session.streamSid,
    });
  }

  session.lastAssistantItem = undefined;
  session.responseStartTimestamp = undefined;
}

function closeModel() {
  cleanupConnection(session.modelConn);
  session.modelConn = undefined;
  if (!session.twilioConn && !session.frontendConn) session = {};
}

function closeAllConnections() {
  if (session.twilioConn) {
    session.twilioConn.close();
    session.twilioConn = undefined;
  }
  if (session.modelConn) {
    session.modelConn.close();
    session.modelConn = undefined;
  }
  if (session.frontendConn) {
    session.frontendConn.close();
    session.frontendConn = undefined;
  }
  session.streamSid = undefined;
  session.lastAssistantItem = undefined;
  session.responseStartTimestamp = undefined;
  session.latestMediaTimestamp = undefined;
  session.saved_config = undefined;
}

function cleanupConnection(ws?: WebSocket) {
  if (isOpen(ws)) ws.close();
}

function parseMessage(data: RawData): any {
  try {
    return JSON.parse(data.toString());
  } catch {
    return null;
  }
}

function jsonSend(ws: WebSocket | undefined, obj: unknown) {
  if (!isOpen(ws)) return;
  ws.send(JSON.stringify(obj));
}

function isOpen(ws?: WebSocket): ws is WebSocket {
  return !!ws && ws.readyState === WebSocket.OPEN;
}
