import { useState, type FormEvent } from "react";
import { KeyRound, MonitorSmartphone } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { getRemotePairingState, pairRemoteDevice } from "@/lib/api";

interface RemotePairingPageProps {
  onPaired: () => void;
}

/** 引导 PWA 使用桌面端一次性配对码登记当前设备。 */
export function RemotePairingPage({ onPaired }: RemotePairingPageProps) {
  const [code, setCode] = useState("");
  const [deviceName, setDeviceName] = useState(() => navigator.userAgent.includes("Android") ? "Android 设备" : "移动设备");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { remoteUrl } = getRemotePairingState();

  /** 校验并提交设备配对请求。 */
  async function submitPairing(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await pairRemoteDevice(code.trim(), deviceName.trim());
      onPaired();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "设备配对失败");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="flex min-h-screen min-h-dvh items-center justify-center bg-background p-4">
      <Card className="w-full max-w-md">
        <CardHeader>
          <div className="mb-2 flex size-11 items-center justify-center rounded-md bg-primary text-primary-foreground">
            <MonitorSmartphone />
          </div>
          <CardTitle>连接 Ani Tracker 桌面端</CardTitle>
          <CardDescription>在桌面端“设置 → 远程设备”生成六位配对码，有效期两分钟。</CardDescription>
        </CardHeader>
        <CardContent>
          <form id="remote-pairing-form" onSubmit={(event) => void submitPairing(event)}>
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="remote-device-name">设备名称</FieldLabel>
                <Input
                  id="remote-device-name"
                  autoComplete="off"
                  maxLength={80}
                  value={deviceName}
                  onChange={(event) => setDeviceName(event.target.value)}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="remote-pairing-code">六位配对码</FieldLabel>
                <Input
                  id="remote-pairing-code"
                  autoComplete="one-time-code"
                  inputMode="numeric"
                  maxLength={6}
                  pattern="[0-9]{6}"
                  placeholder="000000"
                  value={code}
                  onChange={(event) => setCode(event.target.value.replace(/\D/g, "").slice(0, 6))}
                />
                <FieldDescription className="break-all">服务地址：{remoteUrl}</FieldDescription>
              </Field>
            </FieldGroup>
          </form>
          {error && (
            <Alert className="mt-4" variant="destructive">
              <AlertTitle>配对失败</AlertTitle>
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
        </CardContent>
        <CardFooter>
          <Button
            className="w-full"
            disabled={submitting || code.length !== 6 || !deviceName.trim()}
            form="remote-pairing-form"
            type="submit"
          >
            <KeyRound data-icon="inline-start" />
            {submitting ? "正在配对" : "连接桌面端"}
          </Button>
        </CardFooter>
      </Card>
    </main>
  );
}
