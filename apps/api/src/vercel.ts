import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { ExpressAdapter } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import express from 'express';

const server = express();
let cachedApp: any;

export const createHandler = async (expressInstance: express.Express) => {
  if (cachedApp) return cachedApp;

  const app = await NestFactory.create(
    AppModule,
    new ExpressAdapter(expressInstance),
  );
  
  app.setGlobalPrefix('api');
  
  const frontendUrl = process.env.FRONTEND_URL ?? "http://localhost:3000";
  app.enableCors({
    origin: [
      frontendUrl,
      "http://localhost:3000",
      "https://recursomusical.com.mx",
      "https://www.recursomusical.com.mx",
      "https://api.recursomusical.com.mx",
      "https://whatsapp.recursomusical.com.mx",
      /https?:\/\/([a-z0-9-]+\.)*recursomusical\.com\.mx$/,
      /\.vercel\.app$/,
    ],
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"],
    allowedHeaders: [
      "Content-Type",
      "Authorization",
      "X-Requested-With",
      "Accept",
      "Origin",
    ],
    credentials: true,
  });
  
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  
  await app.init();
  cachedApp = app;
  return app;
};

// Vercel entry point
export default async (req: any, res: any) => {
  await createHandler(server);
  server(req, res);
};
