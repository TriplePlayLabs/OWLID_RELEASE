import { execFileSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import QRCode from 'qrcode'

const here = dirname(fileURLToPath(import.meta.url))

/**
 * The verifier reaches the PredicateSelector only after its camera scans
 * a holder's `OWLP1:` engagement QR. To drive that real flow headlessly we
 * feed Chromium a fake camera (`--use-file-for-fake-video-capture`) whose
 * frames are a QR encoding the engagement below. zxing (the scanner's
 * decoder) reads it exactly as it would a real holder phone on screen.
 *
 * The WS URL host never has to resolve — the spec overrides window.WebSocket
 * and drives the handshake by hand.
 */
export const ENGAGEMENT_WS_URL = 'ws://verifier.test/ws/presentation/sess-e2e'
export const ENGAGEMENT_QR = `OWLP1:${ENGAGEMENT_WS_URL}`
export const FAKE_VIDEO_PATH = join(here, 'fixtures', 'engagement-qr.y4m')

export default async function globalSetup() {
  const dir = join(here, 'fixtures')
  mkdirSync(dir, { recursive: true })

  // High error-correction + a generous quiet zone so the QR survives the
  // scale/pad into a 640x480 camera frame and decodes on the first frame.
  const png = join(tmpdir(), 'owlid-e2e-engagement-qr.png')
  await QRCode.toFile(png, ENGAGEMENT_QR, {
    width: 460,
    margin: 4,
    errorCorrectionLevel: 'H',
  })

  // Loop the still QR into a few seconds of raw Y4M video Chromium can
  // serve as a fake webcam. neighbor scaling keeps the modules crisp.
  execFileSync(
    'ffmpeg',
    [
      '-y',
      '-loop',
      '1',
      '-i',
      png,
      '-t',
      '4',
      '-r',
      '15',
      // 720x720 clears the scanner's getUserMedia floor (height/width min 640).
      '-vf',
      'scale=600:600:flags=neighbor,pad=720:720:60:60:white,format=yuv420p',
      '-pix_fmt',
      'yuv420p',
      FAKE_VIDEO_PATH,
    ],
    { stdio: 'ignore' },
  )
}
