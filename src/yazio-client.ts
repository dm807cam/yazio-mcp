import { Yazio } from 'yazio';
import type { YazioAddWaterIntakeOptions } from './types.js';

export interface YazioCredentials {
  username: string;
  password: string;
}

/**
 * Read Yazio credentials from the environment.
 * Returns null when either is missing; callers decide how to fail.
 */
export function credentialsFromEnv(): YazioCredentials | null {
  const username = process.env.YAZIO_USERNAME;
  const password = process.env.YAZIO_PASSWORD;
  if (!username || !password) {
    return null;
  }
  return { username, password };
}

/**
 * Extend yazio client package with addWaterIntake method
 * Discussion https://github.com/juriadams/yazio/issues/3
 */
function extendWaterIntakeSupport(client: Yazio): void {
  // @ts-expect-error - Monkey-patching yazio client to add missing method
  client.user.addWaterIntake = async (entries: YazioAddWaterIntakeOptions): Promise<void> => {
    // @ts-expect-error - Accessing internal auth token from yazio client
    const token = client.auth.token.access_token;

    const baseUrl = (client as Yazio & { baseUrl?: string }).baseUrl || 'https://yzapi.yazio.com/v15';

    const response = await fetch(`${baseUrl}/user/water-intake`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
      },
      body: JSON.stringify(entries),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Failed to add water intake: ${response.status} ${response.statusText} - ${errorText}`);
    }
  };
}

/**
 * Build an authenticated Yazio client. Throws if the credentials are rejected;
 * unlike the previous inline version this never calls process.exit, so the HTTP
 * entrypoint can surface the failure instead of dying silently.
 */
export async function createYazioClient(credentials: YazioCredentials): Promise<Yazio> {
  const client = new Yazio({ credentials });
  // Test the connection
  await client.user.get();
  extendWaterIntakeSupport(client);
  return client;
}
