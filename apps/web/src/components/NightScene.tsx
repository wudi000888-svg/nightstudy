// Original vector illustration. No imported photograph or third-party wallpaper.
export function NightScene() {
  return (
    <svg
      className="night-scene"
      viewBox="0 0 620 440"
      role="img"
      aria-label="雨夜窗边，一盏暖灯照着打开的书"
    >
      <defs>
        <linearGradient id="window-night" x2="0" y2="1">
          <stop stopColor="#182937" />
          <stop offset="1" stopColor="#263b3d" />
        </linearGradient>
        <radialGradient id="lamp-halo">
          <stop stopColor="#e9b36d" stopOpacity=".3" />
          <stop offset="1" stopColor="#e9b36d" stopOpacity="0" />
        </radialGradient>
        <linearGradient id="desk-light">
          <stop stopColor="#b0875e" />
          <stop offset="1" stopColor="#62503f" />
        </linearGradient>
      </defs>
      <path d="M140 33H569V324H140Z" fill="url(#window-night)" stroke="#334242" strokeWidth="8" />
      <path
        d="M146 253L183 205L225 237L260 166L305 218L334 189L373 223L403 161L452 217L483 181L563 260V319H146Z"
        fill="#11262b"
      />
      <path
        d="M145 293L200 261L230 289L275 248L305 275L350 252L389 287L425 258L465 285L506 246L565 282V319H145Z"
        fill="#0f2023"
      />
      <g stroke="#91adb4" strokeWidth="1.2" opacity=".25">
        {Array.from({ length: 27 }, (_, i) => (
          <path key={i} d={`M${155 + i * 15} ${45 + ((i * 37) % 150)}l-7 40`} />
        ))}
      </g>
      <path d="M352 37V320M145 177H566" stroke="#344344" strokeWidth="8" />
      <path d="M130 330H578" stroke="#4f554b" strokeWidth="12" />
      <ellipse cx="198" cy="262" rx="160" ry="150" fill="url(#lamp-halo)" />
      <path d="M27 368H607L620 395H8Z" fill="url(#desk-light)" />
      <path d="M76 392V439M560 392V439" stroke="#463e34" strokeWidth="12" />
      <path
        d="M87 370H159M127 366L149 254L171 201"
        stroke="#a38963"
        strokeWidth="7"
        strokeLinecap="round"
      />
      <path d="M125 218Q170 176 209 215L219 248H115Z" fill="#d9ac6d" />
      <path d="M119 248H216" stroke="#f5d59c" strokeWidth="5" />
      <path
        d="M228 348Q275 334 322 351Q366 333 412 347L428 375Q369 360 322 377Q276 360 219 374Z"
        fill="#d4c2a4"
      />
      <path d="M322 351V376M230 352L301 360M344 360L402 353" stroke="#9a896f" strokeWidth="2" />
      <path d="M463 335H505V365Q484 379 463 365Z" fill="#809794" />
      <path
        d="M505 340Q528 339 527 350Q525 365 506 361"
        fill="none"
        stroke="#809794"
        strokeWidth="5"
      />
      <path
        d="M483 326Q473 310 485 298M494 326Q483 310 495 300"
        stroke="#b6c4b2"
        opacity=".35"
        fill="none"
        strokeWidth="2"
      />
      <path
        d="M62 356V277M53 300Q35 276 49 258Q67 277 62 301M63 321Q89 289 90 317Q80 330 63 334"
        fill="#668274"
        stroke="#668274"
        strokeWidth="3"
      />
      <path d="M40 338H82L73 370H47Z" fill="#725f4b" />
    </svg>
  );
}
