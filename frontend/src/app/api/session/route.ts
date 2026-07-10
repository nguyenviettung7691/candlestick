import { NextResponse } from 'next/server';

import { createSession } from '@/lib/server/persistence';

export const runtime = 'nodejs';

const DEFAULT_USER_ID = 'demo-user';

export async function POST() {
  try {
    const session = await createSession(DEFAULT_USER_ID);
    const response = NextResponse.json(
      {
        ok: true,
        user_id: session.userId,
        expires_at_epoch: session.expiresAtEpoch,
      },
      { status: 201 },
    );

    response.cookies.set('candlestick_session', session.token, {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      path: '/',
      maxAge: Math.max(session.expiresAtEpoch - Math.floor(Date.now() / 1000), 60),
    });

    return response;
  } catch (error) {
    return NextResponse.json(
      {
        ok: false,
        message: error instanceof Error ? error.message : 'Failed to create session.',
      },
      { status: 500 },
    );
  }
}
