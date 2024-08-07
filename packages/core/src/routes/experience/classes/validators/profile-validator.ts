import { type PasswordPolicyChecker, type UserInfo } from '@logto/core-kit';

import RequestError from '#src/errors/RequestError/index.js';
import type Libraries from '#src/tenants/Libraries.js';
import type Queries from '#src/tenants/Queries.js';
import assertThat from '#src/utils/assert-that.js';

import type { InteractionProfile } from '../../types.js';

export class ProfileValidator {
  constructor(
    private readonly libraries: Libraries,
    private readonly queries: Queries,
    /** UserId is required for existing user profile update validation */
    private readonly userId?: string
  ) {}

  public async guardProfileUniquenessAcrossUsers(profile: InteractionProfile) {
    const { hasUser, hasUserWithEmail, hasUserWithPhone, hasUserWithIdentity } = this.queries.users;
    const { userSsoIdentities } = this.queries;

    const { username, primaryEmail, primaryPhone, socialIdentity, enterpriseSsoIdentity } = profile;

    if (username) {
      assertThat(
        !(await hasUser(username)),
        new RequestError({
          code: 'user.username_already_in_use',
          status: 422,
        })
      );
    }

    if (primaryEmail) {
      assertThat(
        !(await hasUserWithEmail(primaryEmail)),
        new RequestError({
          code: 'user.email_already_in_use',
          status: 422,
        })
      );
    }

    if (primaryPhone) {
      assertThat(
        !(await hasUserWithPhone(primaryPhone)),
        new RequestError({
          code: 'user.phone_already_in_use',
          status: 422,
        })
      );
    }

    if (socialIdentity) {
      const {
        target,
        userInfo: { id },
      } = socialIdentity;

      assertThat(
        !(await hasUserWithIdentity(target, id)),
        new RequestError({
          code: 'user.identity_already_in_use',
          status: 422,
        })
      );
    }

    if (enterpriseSsoIdentity) {
      const { issuer, identityId } = enterpriseSsoIdentity;
      const userSsoIdentity = await userSsoIdentities.findUserSsoIdentityBySsoIdentityId(
        issuer,
        identityId
      );

      assertThat(
        !userSsoIdentity,
        new RequestError({
          code: 'user.identity_already_in_use',
          status: 422,
        })
      );
    }
  }

  /**
   * Validate password against the given password policy
   * throw a {@link RequestError} -422 if the password is invalid; otherwise, do nothing.
   */
  public async validatePassword(
    password: string,
    passwordPolicyChecker: PasswordPolicyChecker,
    userInfo: UserInfo = {}
  ) {
    const issues = await passwordPolicyChecker.check(
      password,
      passwordPolicyChecker.policy.rejects.userInfo ? userInfo : {}
    );

    if (issues.length > 0) {
      throw new RequestError({ code: 'password.rejected', status: 422 }, { issues });
    }
  }
}
