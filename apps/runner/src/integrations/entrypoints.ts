// Persistent entrypoints the integration host hands to gatekeepers (ADR 0050). Each is minted
// with props (`ctx.exports.X({ props })`), so a gatekeeper can store it and call it back later:
// - ConnectCallback: the connect flow's `GatekeeperConnectCallback` for one connection;
// - HostHookInitiator: a bound hook's `HookInitiator`, whose startHook() opens one firing.
// Both forward to the connection's integration host Durable Object.
import { WorkerEntrypoint } from "cloudflare:workers";

function host(env: Env, connectionId: string) {
  return env.INTEGRATION_HOST.getByName(connectionId);
}

export class ConnectCallback extends WorkerEntrypoint<
  Env,
  { connectionId: string; vendor: string }
> {
  async complete(user: unknown, expiresAt?: Date) {
    return host(this.env, this.ctx.props.connectionId).stage(
      this.ctx.props.vendor,
      user,
      expiresAt,
    );
  }

  async reconnectComplete(stageId: string, _expiresAt?: Date) {
    return host(this.env, this.ctx.props.connectionId).stageReconnect(
      this.ctx.props.vendor,
      stageId,
    );
  }

  async credentialsExpired(): Promise<void> {
    await host(this.env, this.ctx.props.connectionId).credentialsChanged("expired");
  }

  async credentialsRestored(_expiresAt?: Date): Promise<void> {
    await host(this.env, this.ctx.props.connectionId).credentialsChanged("restored");
  }
}

export class HostHookInitiator extends WorkerEntrypoint<
  Env,
  { connectionId: string; hookId: string }
> {
  async startHook() {
    return host(this.env, this.ctx.props.connectionId).startHook(this.ctx.props.hookId);
  }
}
