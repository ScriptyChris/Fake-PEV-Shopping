import getLogger from '../../../utils/logger';
import * as bcrypt from 'bcrypt';
import * as jwt from 'jsonwebtoken';
import { Request, Response, NextFunction } from 'express';
import * as dotenv from 'dotenv';
import fetch, { FetchError, RequestInit, Response as FetchResponse } from 'node-fetch';
import { PAYU_DEFAULTS } from '../helpers/payu-api';

// @ts-ignore
dotenv.default.config();

if (!process.env.SECRET_KEY) {
  process.env.SECRET_KEY = 'VeRy-SeCrEt-KeY';
}

const {
  // @ts-ignore
  default: { compare, hash },
} = bcrypt;
const {
  // @ts-ignore
  default: { sign, verify },
} = jwt;
const logger = getLogger(module.filename);
const SALT_ROUNDS = 8;

type TToken = { _id: number };

const comparePasswords = (password: string, passwordPattern: string): Promise<boolean> => {
  return compare(password, passwordPattern);
};

const hashPassword = (password: string): Promise<string> => {
  return hash(password, SALT_ROUNDS);
};

const getToken = (payloadObj: TToken): string => {
  return sign(payloadObj, process.env.SECRET_KEY);
};

const verifyToken = (token: string): TToken => {
  return verify(token, process.env.SECRET_KEY) as TToken;
};

const authMiddlewareFn = (getFromDB: /* TODO: correct typing */ any): ((...args: any) => Promise<void>) => {
  return async (req: Request & { token: string; user: any }, res: Response, next: NextFunction) => {
    try {
      const token: string = (req.header('Authorization') as string).replace('Bearer ', '');
      const decodedToken: TToken = verifyToken(token);
      const user: any = await getFromDB({ _id: decodedToken._id.toString(), 'tokens.token': token }, 'User');

      if (!user) {
        throw new Error('Auth failed!');
      }

      req.token = token;
      req.user = user;

      next();
    } catch (exception) {
      logger.error('authMiddleware exception', exception);
      res.status(401).json({ error: 'You are unauthorized!' });
    }
  };
};

const userRoleMiddlewareFn = (roleName: string): any => {
  return async (req: Request & { user: any; userPermissions: string[] }, res: Response, next: NextFunction) => {
    try {
      if (!req.user) {
        throw new Error('No user provided - probably forgot to do auth first.');
      }

      // TODO: improve selecting data while populating
      await req.user.execPopulate({
        path: 'roleName',
        match: { roleName },
      });

      req.userPermissions = req.user.roleName[0].permissions;

      next();
    } catch (exception) {
      logger.error('userRoleMiddlewareFn exception', exception);
      res.status(403).json({ error: "You don't have permissions!" });
    }
  };
};

const authToPayU: () => Promise<string | Error> = (() => {
  const clientId: string = process.env.CLIENT_ID || PAYU_DEFAULTS.CLIENT_ID;
  const clientSecret: string = process.env.CLIENT_SECRET || PAYU_DEFAULTS.CLIENT_SECRET;
  const PAYU_AUTH_URL = 'https://secure.snd.payu.com/pl/standard/user/oauth/authorize';
  const options: RequestInit = {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: `grant_type=client_credentials&client_id=${clientId}&client_secret=${clientSecret}`,
  };

  interface IPayUToken {
    access_token: string;
    token_type: 'bearer';
    expires_in: number;
    grant_type: 'client_credentials';
  }
  let token: IPayUToken | null = null;
  let tokenReceiveTimeInSec = 0;

  return function getToken(): Promise<string | Error> {
    if (isTokenValid()) {
      return Promise.resolve(((token as unknown) as IPayUToken).access_token);
    }

    logger.log('authToPayU /PAYU_AUTH_URL:', PAYU_AUTH_URL, ' /options:', options);

    return (
      fetch(PAYU_AUTH_URL, options)
        .then((response: FetchResponse) => response.json())
        .then((response: IPayUToken) => {
          token = response;
          tokenReceiveTimeInSec = getCurrentTimeInSec();

          logger.log('PayU auth token:', token);

          return token.access_token;
        })
        // TODO: handle error in a better way
        .catch((error: Error) => {
          logger.error('PayU token fetching error:', error);

          return error;
        })
    );
  };

  function isTokenValid(): boolean {
    return !!token && tokenReceiveTimeInSec + token.expires_in < getCurrentTimeInSec();
  }

  function getCurrentTimeInSec(): number {
    return Math.floor(Date.now() / 1000);
  }
})();

export { comparePasswords, hashPassword, getToken, verifyToken, authMiddlewareFn, userRoleMiddlewareFn, authToPayU };
