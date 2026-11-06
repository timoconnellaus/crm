// Settings → Voice (ADR 0349): how the assistant sounds and how you talk to it. Voice, speed and
// how much is read out are yours everywhere; how you talk is per device. Speed shows only when the
// speech provider supports it. Changes save at once.
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@relationship-os/ui/components/card";
import { Button } from "@relationship-os/ui/components/button";
import { Label } from "@relationship-os/ui/components/label";
import { Skeleton } from "@relationship-os/ui/components/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@relationship-os/ui/components/table";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useMemo } from "react";
import { toast } from "sonner";
import {
  ModeChoice,
  SpeedSlider,
  useVoiceSetup,
  VoiceList,
  type VoiceMode,
  voiceDeviceId,
  voiceDeviceLabel,
} from "#/components/assistant/voice";
import { ErrorState } from "#/components/empty-state";
import { PageLayout } from "#/components/layout/page-layout";
import { errorMessage, useOp, useOpMutation } from "#/lib/query";

export const Route = createFileRoute("/_app/settings/voice")({ component: VoiceSettingsPage });

const MODE_LABELS: Record<VoiceMode, string> = {
  push_to_talk: "Push to talk",
  hands_free: "Hands-free",
};

function VoiceSettingsPage() {
  const deviceId = useMemo(voiceDeviceId, []);
  const prefs = useOp("voice.prefs.get", { deviceId });
  const update = useOpMutation("voice.prefs.update", { invalidates: ["voice."] });
  const runSetup = useVoiceSetup();
  const data = prefs.data;

  async function change(values: {
    voiceId?: string;
    speed?: number;
    mode?: VoiceMode;
    readOut?: "short" | "full";
    forgetDeviceId?: string;
  }) {
    try {
      await update.mutateAsync({ deviceId, deviceLabel: voiceDeviceLabel(), ...values });
      toast.success("Saved");
    } catch (error) {
      toast.error(errorMessage(error));
    }
  }

  return (
    <PageLayout title="Voice" description="How the assistant sounds and how you talk to it.">
      {prefs.isPending ? (
        <Skeleton className="h-64" />
      ) : prefs.isError || !data ? (
        <ErrorState title="Voice settings could not load" error={prefs.error} />
      ) : !data.available ? (
        <Card data-testid="voice-off">
          <CardHeader>
            <CardTitle>Voice is off</CardTitle>
            <CardDescription>
              An admin can switch it on by adding an AssemblyAI key in{" "}
              <Link to="/settings/ai" className="underline">
                Settings → AI
              </Link>
              .
            </CardDescription>
          </CardHeader>
        </Card>
      ) : !data.configured ? (
        <Card>
          <CardHeader>
            <CardTitle>Voice isn't set up yet</CardTitle>
            <CardDescription>Pick a voice and how you'd like to talk.</CardDescription>
          </CardHeader>
          <CardContent>
            <Button onClick={runSetup} data-testid="voice-run-setup">
              Set up voice
            </Button>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-4" data-testid="voice-settings">
          <Card>
            <CardHeader>
              <CardTitle>Voice</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <VoiceList
                prefs={data}
                value={data.voiceId}
                onChange={(voiceId) => void change({ voiceId })}
              />
              {data.supportsSpeed && (
                <SpeedSlider value={data.speed} onChange={(speed) => void change({ speed })} />
              )}
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>How you talk on this device</CardTitle>
              <CardDescription>{voiceDeviceLabel()}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <ModeChoice value={data.mode} onChange={(mode) => void change({ mode })} />
              {data.devices.length > 0 && (
                <Table aria-label="Your devices" data-testid="voice-devices">
                  <TableHeader>
                    <TableRow>
                      <TableHead>Device</TableHead>
                      <TableHead>How you talk</TableHead>
                      <TableHead />
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {data.devices.map((device) => (
                      <TableRow key={device.id}>
                        <TableCell>
                          {device.label}
                          {device.thisDevice && (
                            <span className="ml-2 text-xs text-muted-foreground">This device</span>
                          )}
                        </TableCell>
                        <TableCell>{MODE_LABELS[device.mode]}</TableCell>
                        <TableCell className="text-right">
                          {!device.thisDevice && (
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() => void change({ forgetDeviceId: device.id })}
                            >
                              Forget
                            </Button>
                          )}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
              <p className="text-xs text-muted-foreground">
                Each device keeps its own choice. A new device starts with what you picked at first
                setup ({MODE_LABELS[data.defaultMode].toLowerCase()}).
              </p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>When you can see the screen</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-sm">
              {(
                [
                  ["short", "Say a short version, show the full answer and cards in the chat"],
                  ["full", "Read everything out"],
                ] as const
              ).map(([id, label]) => (
                <Label key={id} className="flex items-center gap-2 font-normal">
                  <input
                    type="radio"
                    name="read-out"
                    checked={data.readOut === id}
                    onChange={() => void change({ readOut: id })}
                    data-testid={`voice-read-${id}`}
                  />
                  {label}
                </Label>
              ))}
              <p className="text-xs text-muted-foreground">
                In the full-screen phone view the chat is hidden, so I always read cards out. You
                can also just say "read me everything" during a chat.
              </p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>Interruptions</CardTitle>
              <CardDescription>
                I stop talking as soon as you speak. Anything I didn't finish is marked "Partly
                heard" in the chat.
              </CardDescription>
            </CardHeader>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>Speech services</CardTitle>
              <CardDescription>
                Speech to text and voices: AssemblyAI. Set by your admin in AI settings.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Button variant="outline" onClick={runSetup} data-testid="voice-run-setup">
                Run voice setup again
              </Button>
            </CardContent>
          </Card>
        </div>
      )}
    </PageLayout>
  );
}
