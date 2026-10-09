# Linaw volume helper (Windows): reads commands on stdin, one per line, answers one line each.
#   get        -> the default speaker's master volume, 0..1
#   set 0.25   -> sets it, answers the previous level
# Started once by volume.cjs and kept running, so each command is instant.
#
# Ducking the master volume lowers what the user hears, but not what Linaw records: Windows applies
# the master volume after the loopback capture point, so the transcript stays at full level.

$ErrorActionPreference = 'Stop'

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;

[ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")] class LinawMMDeviceEnumerator {}

[ComImport, Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface ILinawMMDeviceEnumerator {
  [PreserveSig] int EnumAudioEndpoints(int dataFlow, int stateMask, out IntPtr devices);
  [PreserveSig] int GetDefaultAudioEndpoint(int dataFlow, int role, out ILinawMMDevice device);
}

[ComImport, Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface ILinawMMDevice {
  [PreserveSig] int Activate(ref Guid iid, int clsCtx, IntPtr activationParams, [MarshalAs(UnmanagedType.IUnknown)] out object instance);
}

[ComImport, Guid("5CDF2C82-841E-4546-9722-0CF74078229A"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface ILinawAudioEndpointVolume {
  [PreserveSig] int RegisterControlChangeNotify(IntPtr notify);
  [PreserveSig] int UnregisterControlChangeNotify(IntPtr notify);
  [PreserveSig] int GetChannelCount(out uint count);
  [PreserveSig] int SetMasterVolumeLevel(float levelDb, ref Guid context);
  [PreserveSig] int SetMasterVolumeLevelScalar(float level, ref Guid context);
  [PreserveSig] int GetMasterVolumeLevel(out float levelDb);
  [PreserveSig] int GetMasterVolumeLevelScalar(out float level);
}

public static class LinawVolume {
  static ILinawAudioEndpointVolume Endpoint() {
    var enumerator = (ILinawMMDeviceEnumerator)new LinawMMDeviceEnumerator();
    ILinawMMDevice device;
    Marshal.ThrowExceptionForHR(enumerator.GetDefaultAudioEndpoint(0 /* render */, 1 /* multimedia */, out device));
    Guid iid = typeof(ILinawAudioEndpointVolume).GUID;
    object o;
    Marshal.ThrowExceptionForHR(device.Activate(ref iid, 23 /* CLSCTX_ALL */, IntPtr.Zero, out o));
    return (ILinawAudioEndpointVolume)o;
  }
  public static float Get() { float v; Marshal.ThrowExceptionForHR(Endpoint().GetMasterVolumeLevelScalar(out v)); return v; }
  public static float Set(float level) {
    var e = Endpoint();
    float before;
    Marshal.ThrowExceptionForHR(e.GetMasterVolumeLevelScalar(out before));
    Guid context = Guid.Empty;
    Marshal.ThrowExceptionForHR(e.SetMasterVolumeLevelScalar(Math.Max(0f, Math.Min(1f, level)), ref context));
    return before;
  }
}
"@

$inv = [Globalization.CultureInfo]::InvariantCulture
[Console]::Out.WriteLine('ready')
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  try {
    if ($line -eq 'get') {
      $answer = [LinawVolume]::Get().ToString($inv)
    } elseif ($line -match '^set ([0-9.]+)$') {
      $answer = [LinawVolume]::Set([float]::Parse($Matches[1], $inv)).ToString($inv)
    } else {
      $answer = 'error unknown command'
    }
  } catch {
    $answer = 'error ' + ($_.Exception.Message -replace '\s+', ' ')
  }
  [Console]::Out.WriteLine($answer)
}
