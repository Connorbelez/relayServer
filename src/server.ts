import express, { Request, Response, RequestHandler } from "express";
import { WebSocketServer, WebSocket } from "ws";
import { IncomingMessage } from "http";
import dotenv from "dotenv";
import http from "http";
import { readFileSync } from "fs";
import { join } from "path";
import cors from "cors";
import {
  handleCallConnection,
  handleFrontendConnection,
} from "./sessionManager";
import functions from "./functionHandlers";
import { publicKey, privateKey, generateToken, verifyToken } from './utils/auth';

dotenv.config();

const PORT = parseInt(process.env.PORT || "5050", 10);
const PUBLIC_URL = process.env.PUBLIC_URL || "";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";

if (!OPENAI_API_KEY) {
  console.error("OPENAI_API_KEY environment variable is required");
  process.exit(1);
}

const app = express();

// Add CORS configuration
const allowedOrigins = process.env.ALLOWED_ORIGINS 
  ? process.env.ALLOWED_ORIGINS.split(',') 
  : ['http://localhost:3000'];

app.use(cors({
  origin: (origin, callback) => {
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true
}));

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

app.use(express.urlencoded({ extended: false }));
app.use(express.json());

const twimlPath = join(__dirname, "twiml.xml");
const twimlTemplate = readFileSync(twimlPath, "utf-8");

app.get("/public-url", (req, res) => {
  res.json({ publicUrl: PUBLIC_URL });
});

app.all("/twiml", (req, res) => {
  const wsUrl = new URL(PUBLIC_URL);
  wsUrl.protocol = "wss:";
  wsUrl.pathname = `/call`;

  const twimlContent = twimlTemplate.replace("{{WS_URL}}", wsUrl.toString());
  res.type("text/xml").send(twimlContent);
});

// New endpoint to list available tools (schemas)
app.get("/tools", (req, res) => {
  res.json(functions.map((f) => f.schema));
});

// Add this endpoint to serve the public key
app.get("/auth/public-key", (req, res) => {
  res.json({ publicKey });
});

// Update the token endpoint
const tokenHandler: RequestHandler = (req: Request, res: Response) => {
  console.log('SERVER TOKEN HANDLER');
  console.log('Request:', req);
  console.log('Auth header:', req.headers.authorization);
  
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    console.log('Missing or invalid auth header');
    res.status(401).json({ error: 'Missing API key' });
    return;
  }

  const apiKey = authHeader.split(' ')[1];
  console.log('Extracted API key:', apiKey);
  
  try {
    const token = generateToken(apiKey);
    console.log('Generated token:', token);
    res.json({ token });
  } catch (error) {
    console.error('Token generation error:', error);
    res.status(401).json({ error: 'Invalid API key' });
  }
};

app.post("/logs/auth/token", tokenHandler);

// app.post("/outbound", handleOutboundCall)

const handleOutboundCall = async (req: Request, res: Response) => {
  console.log("OUTBOUND CALL");
  //initialize the call
  //get the phone number
  const phoneNumber = req.body.phoneNumber;
  const name = req.body.name;
  const email = req.body.email? req.body.email : "";
  const message = req.body.message? req.body.message : "";

  //initiate the call
  
  res.json({ message: "Outbound call received" });
}



let currentCall: WebSocket | null = null;
let currentLogs: WebSocket | null = null;

//This runs on phone call connection 
wss.on("connection", (ws: WebSocket, req: IncomingMessage) => {
  const url = new URL(req.url || "", `http://${req.headers.host}`);
  const token = url.searchParams.get('token');
  

  const parts = url.pathname.split("/").filter(Boolean);

  if (parts.length < 1) {
    ws.close();
    return;
  }

  const type = parts[0];

  if (type === "call") {
    if (currentCall) currentCall.close();
    currentCall = ws;
    handleCallConnection(currentCall, OPENAI_API_KEY);
  } else if (type === "logs") {

  if (!token || !verifyToken(token)) {
    console.error("\n\nSERVER TOKEN ERROR!!!");
    console.error("TOKEN: ", token);
    console.error('Invalid token');
    ws.close()
    return
  }
    console.log("SERVER LOGS CONNECTION");
    if (currentLogs) currentLogs.close();
    currentLogs = ws;
    handleFrontendConnection(currentLogs);
  } else {
    ws.close();
  }
});

server.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
