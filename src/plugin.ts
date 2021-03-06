// eslint-disable-next-line import/no-extraneous-dependencies
// eslint-disable-next-line import/no-extraneous-dependencies
import AdminJS, { AdminJSOptions } from 'adminjs';
import { resolve } from 'path';
import { match } from 'path-to-regexp';
import cookie from 'cookie';
import jwt from 'jsonwebtoken';
import { computeRootPaths } from './utils/compute-root-paths';
import { prepareComparePath } from './utils/prepare-compare-path';


import { AppRoutes, AppAssets } from './utils/routes';
import { parseFiles, cleanFiles, File } from './utils/parse-files';
import { BuildHandlerOptions, BuildHandlerReturn } from './utils/build-handler-options';

const DEFAULT_MAX_AGE = 900000;

/**
 * Builds the handler which can be passed to firebase functions
 *
 * usage:
 *
 * ```javascript
 * const functions = require('firebase-functions')
 * const { buildHandler } = require('@adminjs/firebase-functions')
 *
 * const adminOptions = {...}
 * const region = '...'
 *
 * exports.app = functions.https.onRequest(buildHandler(adminOptions, { region }));
 *
 * ```
 *
 * @alias buildHandler
 * @param  {AdminJSOptions} adminOptions       options which are used to initialize
 *                                              AdminJS instance
 * @param  {BuildHandlerOptions} options        custom options for @adminjs/firebase-functions
 *                                              adapter
 * @return {BuildHandlerReturn}                 function which can be passed to firebase
 * @function
 * @memberof module:@adminjs/firebase-functions
*/
export const buildHandler = (
  adminOptions: AdminJSOptions,
  options: BuildHandlerOptions,
): BuildHandlerReturn => {
  let admin: AdminJS;

  let loginPath: string;
  let logoutPath: string;
  let rootPath: string;

  return async (req, res): Promise<void> => {
    if (!admin) {
      let beforeResult: AdminJSOptions | null | undefined = null;
      if (options.before) {
        beforeResult = await options.before();
      }

      admin = new AdminJS(beforeResult || adminOptions);
      // we have to store original values
      ({ loginPath, logoutPath, rootPath } = admin.options);

      Object.assign(admin.options, computeRootPaths(admin.options, {
        project: process.env.GCLOUD_PROJECT as string,
        region: options.region,
        target: process.env.FUNCTION_TARGET as string,
        emulator: process.env.FUNCTIONS_EMULATOR,
      }, options.customFunctionPath));
    }

    const { method, query } = req;
    const path = prepareComparePath(req.path, rootPath, options.customFunctionPath);

    const cookies = cookie.parse(req.headers.cookie || '');
    const token = cookies && cookies.__session;

    const currentAdmin = options.auth && token && token !== ''
      ? jwt.verify(token, options.auth.secret)
      : null;

    if (options.auth) {
      const matchLogin = match(loginPath);
      if (matchLogin(path)) {
        if (method === 'GET') {
          res.send(await admin.renderLogin({
            action: admin.options.loginPath,
            errorMessage: null,
          }));
        } else {
          const { email, password } = req.body;
          const user = await options.auth.authenticate(email, password);
          if (user) {
            const session = jwt.sign(user, options.auth.secret);
            res.cookie('__session', session, {
              maxAge: options.auth.maxAge || DEFAULT_MAX_AGE,
            });
            res.redirect(admin.options.rootPath);
          } else {
            res.send(await admin.renderLogin({
              action: admin.options.loginPath,
              errorMessage: admin.translateMessage('invalidCredentials'),
            }));
          }
        }
        return;
      }

      const matchLogout = match(logoutPath);
      if (matchLogout(path)) {
        res.cookie('__session', '');
        res.redirect(admin.options.loginPath);
        return;
      }

      if (!currentAdmin) {
        res.redirect(admin.options.loginPath);
        return;
      }

      res.cookie('__session', token, {
        maxAge: options.auth.maxAge || DEFAULT_MAX_AGE,
      });
    }

    const route = AppRoutes.find((r) => r.match(path) && r.method === method);
    if (route) {
      const params = (route.match(path) as unknown as any).params as Record<string, string>;

      const controller = new route.Controller({ admin }, currentAdmin);
      let fields: Record<string, string> = {};
      let files: Record<string, File> = {};
      if (method === 'POST') {
        ({ fields, files } = await parseFiles(req));
      }
      const payload = {
        ...fields,
        ...files,
      };
      const html = await controller[route.action]({
        ...req, params, query, payload, method: method.toLowerCase(),
      }, res);
      if (route.contentType) {
        res.set({ 'Content-Type': route.contentType });
      }
      if (html) {
        res.send(html);
      }

      if (files) {
        cleanFiles(files);
      }

      return;
    }

    const asset = AppAssets.find((r) => r.match(path));
    if (asset && !admin.options.assetsCDN) {
      res.status(200).sendFile(resolve(asset.src));
      return;
    }

    res.status(404).send('Page not found');
  };
};
