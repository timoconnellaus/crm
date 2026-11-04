// Browser-side Better Auth client. Only used when IDENTITY_PROVIDER=better-auth.
import { createAuthClient } from "better-auth/react";

export const authClient = createAuthClient({ basePath: "/api/auth" });
