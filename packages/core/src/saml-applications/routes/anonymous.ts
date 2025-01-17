import { authRequestInfoGuard } from '@logto/schemas';
import { generateStandardId, generateStandardShortId } from '@logto/shared';
import { cond, removeUndefinedKeys } from '@silverhand/essentials';
import { addMinutes } from 'date-fns';
import { z } from 'zod';

import { spInitiatedSamlSsoSessionCookieName } from '#src/constants/index.js';
import { EnvSet, getTenantEndpoint } from '#src/env-set/index.js';
import RequestError from '#src/errors/RequestError/index.js';
import koaGuard from '#src/middleware/koa-guard.js';
import type { AnonymousRouter, RouterInitArgs } from '#src/routes/types.js';
import assertThat from '#src/utils/assert-that.js';

import {
  generateAutoSubmitForm,
  createSamlResponse,
  handleOidcCallbackAndGetUserInfo,
  getSamlIdpAndSp,
  getSignInUrl,
  buildSamlAppCallbackUrl,
  validateSamlApplicationDetails,
} from './utils.js';

const samlApplicationSignInCallbackQueryParametersGuard = z.union([
  z.object({
    code: z.string(),
  }),
  z.object({
    error: z.string(),
    error_description: z.string().optional(),
  }),
]);

export default function samlApplicationAnonymousRoutes<T extends AnonymousRouter>(
  ...[router, { id: tenantId, libraries, queries, envSet }]: RouterInitArgs<T>
) {
  const {
    samlApplications: { getSamlIdPMetadataByApplicationId },
  } = libraries;
  const {
    applications,
    samlApplicationSecrets,
    samlApplicationConfigs,
    samlApplications: { getSamlApplicationDetailsById },
    samlApplicationSessions: { insertSession },
  } = queries;

  router.get(
    '/saml-applications/:id/metadata',
    koaGuard({
      params: z.object({ id: z.string() }),
      status: [200, 404],
      response: z.string(),
    }),
    async (ctx, next) => {
      const { id } = ctx.guard.params;

      const { metadata } = await getSamlIdPMetadataByApplicationId(id);

      ctx.status = 200;
      ctx.body = metadata;
      ctx.type = 'text/xml;charset=utf-8';

      return next();
    }
  );

  router.get(
    '/saml-applications/:id/callback',
    koaGuard({
      params: z.object({ id: z.string() }),
      // TODO: should be able to handle `state` and `redirectUri`
      query: samlApplicationSignInCallbackQueryParametersGuard,
      status: [200, 400],
    }),
    async (ctx, next) => {
      const {
        params: { id },
        query,
      } = ctx.guard;

      // Handle error in query parameters
      if ('error' in query) {
        throw new RequestError({
          code: 'oidc.invalid_request',
          message: query.error_description,
        });
      }

      // Get application configuration
      const {
        secret,
        oidcClientMetadata: { redirectUris },
      } = await applications.findApplicationById(id);

      const tenantEndpoint = getTenantEndpoint(tenantId, EnvSet.values);
      assertThat(
        redirectUris[0] === buildSamlAppCallbackUrl(tenantEndpoint, id),
        'oidc.invalid_redirect_uri'
      );

      // TODO: should be able to handle `state` and code verifier etc.
      const { code } = query;

      // Handle OIDC callback and get user info
      const userInfo = await handleOidcCallbackAndGetUserInfo(
        code,
        id,
        secret,
        redirectUris[0],
        envSet.oidc.issuer
      );

      // TODO: we will refactor the following code later, to reduce the DB query connections.
      // Get SAML configuration
      const { metadata } = await getSamlIdPMetadataByApplicationId(id);
      const { privateKey, certificate } =
        await samlApplicationSecrets.findActiveSamlApplicationSecretByApplicationId(id);
      const { entityId, acsUrl } =
        await samlApplicationConfigs.findSamlApplicationConfigByApplicationId(id);

      assertThat(entityId, 'application.saml.entity_id_required');
      assertThat(acsUrl, 'application.saml.acs_url_required');

      // Setup SAML providers and create response
      const { idp, sp } = getSamlIdpAndSp({
        idp: { metadata, privateKey, certificate },
        sp: { entityId, acsUrl },
      });
      const { context, entityEndpoint } = await createSamlResponse(idp, sp, userInfo);

      // Return auto-submit form
      ctx.body = generateAutoSubmitForm(entityEndpoint, context);
      return next();
    }
  );

  // Redirect binding SAML authentication request endpoint
  router.get(
    '/saml/:id/authn',
    koaGuard({
      params: z.object({ id: z.string() }),
      query: z
        .object({
          SAMLRequest: z.string().min(1),
          Signature: z.string().optional(),
          SigAlg: z.string().optional(),
          RelayState: z.string().optional(),
        })
        .catchall(z.string()),
      status: [200, 302, 400, 404],
    }),
    async (ctx, next) => {
      const {
        params: { id },
        query: { Signature, RelayState, ...rest },
      } = ctx.guard;

      const [{ metadata }, details] = await Promise.all([
        getSamlIdPMetadataByApplicationId(id),
        getSamlApplicationDetailsById(id),
      ]);

      const { entityId, acsUrl, redirectUri, certificate, privateKey } =
        validateSamlApplicationDetails(details);

      const { idp, sp } = getSamlIdpAndSp({
        idp: { metadata, certificate, privateKey },
        sp: { entityId, acsUrl },
      });

      const octetString = Object.keys(ctx.request.query)
        // eslint-disable-next-line no-restricted-syntax
        .map((key) => key + '=' + encodeURIComponent(ctx.request.query[key] as string))
        .join('&');
      const { SAMLRequest, SigAlg } = rest;

      // Parse login request
      try {
        const loginRequestResult = await idp.parseLoginRequest(sp, 'redirect', {
          query: removeUndefinedKeys({
            SAMLRequest,
            Signature,
            SigAlg,
          }),
          octetString,
        });

        const extractResult = authRequestInfoGuard.safeParse(loginRequestResult.extract);

        if (!extractResult.success) {
          throw new RequestError({
            code: 'application.saml.invalid_saml_request',
            error: extractResult.error.flatten(),
          });
        }

        assertThat(
          extractResult.data.issuer === entityId,
          'application.saml.auth_request_issuer_not_match'
        );

        const state = generateStandardId(32);
        const signInUrl = await getSignInUrl({
          issuer: envSet.oidc.issuer,
          applicationId: id,
          redirectUri,
          state,
        });

        const currentDate = new Date();
        const expiresAt = addMinutes(currentDate, 60); // Lifetime of the session is 60 minutes.
        const createSession = {
          id: generateStandardId(32),
          applicationId: id,
          oidcState: state,
          samlRequestId: extractResult.data.request.id,
          rawAuthRequest: SAMLRequest,
          // Expire the session in 60 minutes.
          expiresAt: expiresAt.getTime(),
          ...cond(RelayState && { relayState: RelayState }),
        };

        const insertSamlAppSession = await insertSession(createSession);
        // Set the session ID to cookie for later use.
        ctx.cookies.set(spInitiatedSamlSsoSessionCookieName, insertSamlAppSession.id, {
          httpOnly: true,
          sameSite: 'strict',
          expires: expiresAt,
          overwrite: true,
        });

        ctx.redirect(signInUrl.toString());
      } catch (error: unknown) {
        if (error instanceof RequestError) {
          throw error;
        }

        throw new RequestError({
          code: 'application.saml.invalid_saml_request',
        });
      }

      return next();
    }
  );

  // Post binding SAML authentication request endpoint
  router.post(
    '/saml/:id/authn',
    koaGuard({
      params: z.object({ id: z.string() }),
      body: z.object({
        SAMLRequest: z.string().min(1),
        RelayState: z.string().optional(),
      }),
      status: [200, 302, 400, 404],
    }),
    async (ctx, next) => {
      const {
        params: { id },
        body: { SAMLRequest, RelayState },
      } = ctx.guard;

      const [{ metadata }, details] = await Promise.all([
        getSamlIdPMetadataByApplicationId(id),
        getSamlApplicationDetailsById(id),
      ]);

      const { acsUrl, entityId, redirectUri, privateKey, certificate } =
        validateSamlApplicationDetails(details);

      const { idp, sp } = getSamlIdpAndSp({
        idp: { metadata, privateKey, certificate },
        sp: { entityId, acsUrl },
      });

      // Parse login request
      try {
        const loginRequestResult = await idp.parseLoginRequest(sp, 'post', {
          body: {
            SAMLRequest,
          },
        });

        const extractResult = authRequestInfoGuard.safeParse(loginRequestResult.extract);

        if (!extractResult.success) {
          throw new RequestError({
            code: 'application.saml.invalid_saml_request',
            error: extractResult.error.flatten(),
          });
        }

        assertThat(
          extractResult.data.issuer === entityId,
          'application.saml.auth_request_issuer_not_match'
        );

        const state = generateStandardShortId();
        const signInUrl = await getSignInUrl({
          issuer: envSet.oidc.issuer,
          applicationId: id,
          redirectUri,
          state,
        });

        const currentDate = new Date();
        const expiresAt = addMinutes(currentDate, 60); // Lifetime of the session is 60 minutes.
        const insertSamlAppSession = await insertSession({
          id: generateStandardId(),
          applicationId: id,
          oidcState: state,
          samlRequestId: extractResult.data.request.id,
          rawAuthRequest: SAMLRequest,
          // Expire the session in 60 minutes.
          expiresAt: expiresAt.getTime(),
          ...cond(RelayState && { relayState: RelayState }),
        });
        // Set the session ID to cookie for later use.
        ctx.cookies.set(spInitiatedSamlSsoSessionCookieName, insertSamlAppSession.id, {
          httpOnly: true,
          sameSite: 'strict',
          expires: expiresAt,
          overwrite: true,
        });

        ctx.redirect(signInUrl.toString());
      } catch (error: unknown) {
        if (error instanceof RequestError) {
          throw error;
        }

        throw new RequestError({
          code: 'application.saml.invalid_saml_request',
        });
      }

      return next();
    }
  );
}
