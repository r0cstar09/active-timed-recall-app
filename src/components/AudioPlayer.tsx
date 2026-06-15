/**
 * Thin wrapper over the native <audio> element.
 *
 * `playsInline` + `preload="none"` are important for iPhone Safari: inline
 * playback (not fullscreen) and no eager buffering. Because the service worker
 * registers no fetch handler, these media requests (including HTTP range
 * requests) reach the network untouched, so seeking/playback works (acceptance
 * tests #8 and #9).
 */
interface Props {
  src: string;
  label?: string;
}

export default function AudioPlayer({ src, label }: Props) {
  return (
    <div>
      {label && <div className="small faint" style={{ marginBottom: 4 }}>{label}</div>}
      <audio
        className="audio-player"
        controls
        preload="none"
        playsInline
        src={src}
      />
    </div>
  );
}
