from PIL import Image, ImageDraw, ImageFont
import os

OUT = '/Users/frankgranato/Desktop/claude projects/PoolCue-v2/public/ads'
os.makedirs(OUT, exist_ok=True)

BG = (10, 10, 10)
GOLD = (245, 197, 24)
DIM = (100, 100, 100)
WHITE = (220, 220, 220)
DARK_LINE = (30, 30, 30)

# Fonts
def font(size, bold=False):
    idx = 1 if bold else 0
    try:
        return ImageFont.truetype('/System/Library/Fonts/Helvetica.ttc', size, index=idx)
    except:
        return ImageFont.load_default()

def center_text(draw, y, text, fnt, fill, img_w):
    bbox = draw.textbbox((0, 0), text, font=fnt)
    tw = bbox[2] - bbox[0]
    draw.text(((img_w - tw) / 2, y), text, font=fnt, fill=fill)

def draw_gold_line(draw, y, w, margin=80):
    draw.line([(margin, y), (w - margin, y)], fill=DARK_LINE, width=1)

# ==========================================
# 1. GAME BANNER — 1080 x 90
# ==========================================
img = Image.new('RGB', (1080, 90), BG)
d = ImageDraw.Draw(img)
draw_gold_line(d, 1, 1080, 40)

# Single line: "YOUR AD HERE  •  Advertise on our boards  •  poolcue.io"
f_main = font(22, bold=True)
f_dim = font(18)

# Build it centered as one string
line = "YOUR AD HERE"
sub = "Advertise on our boards  ·  poolcue.io"

center_text(d, 20, line, f_main, GOLD, 1080)
center_text(d, 50, sub, f_dim, DIM, 1080)

img.save(os.path.join(OUT, 'ad-banner-1080x90.png'), 'PNG')
print('✅ Banner 1080x90')

# ==========================================
# 2. IDLE TOP/BOTTOM — 1080 x 240
# ==========================================
img = Image.new('RGB', (1080, 240), BG)
d = ImageDraw.Draw(img)
draw_gold_line(d, 1, 1080, 100)
draw_gold_line(d, 238, 1080, 100)

f_head = font(36, bold=True)
f_sub = font(22)
f_contact = font(20)

center_text(d, 45, 'YOUR AD HERE', f_head, GOLD, 1080)
center_text(d, 100, 'Interested in advertising on our boards?', f_sub, WHITE, 1080)
center_text(d, 145, 'Reach out at  poolcue.io', f_contact, DIM, 1080)

# Small Pool Cue branding
f_tiny = font(13)
center_text(d, 205, 'POOL CUE', f_tiny, (40, 40, 40), 1080)

img.save(os.path.join(OUT, 'ad-idle-1080x240.png'), 'PNG')
print('✅ Idle 1080x240')

# ==========================================
# 3. SIDE AD — 240 x 1080 (displayed rotated in 120px wide slot)
# Actually the sides rotate a horizontal image. Let's make a 
# horizontal banner that looks good rotated: 1080 x 120
# ==========================================
img = Image.new('RGB', (1080, 120), BG)
d = ImageDraw.Draw(img)
draw_gold_line(d, 1, 1080, 60)
draw_gold_line(d, 118, 1080, 60)

f_side = font(26, bold=True)
f_side_sub = font(18)

center_text(d, 25, 'YOUR AD HERE', f_side, GOLD, 1080)
center_text(d, 65, 'Advertise on our boards  ·  poolcue.io', f_side_sub, DIM, 1080)

img.save(os.path.join(OUT, 'ad-side-1080x120.png'), 'PNG')
print('✅ Side 1080x120')

print(f'\nAll ads saved to {OUT}')
