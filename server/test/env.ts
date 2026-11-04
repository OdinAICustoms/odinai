// Runs before every test file: the tests use their own database (TEST_DATABASE_URL), never the real one.
import path from 'node:path';
import dotenv from 'dotenv';

dotenv.config({ path: path.resolve(__dirname, '..', '..', '.env') });
if (!process.env.TEST_DATABASE_URL) throw new Error('TEST_DATABASE_URL is not set in .env');
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
process.env.NODE_ENV = 'test';
