# Default desktop-pet artwork

The illustrated whale-tail maid animations originate from PC2005-cloud/dsh-pet (Copyright (c) 2026 PC2005-cloud, MIT).

The transparent WebP frame sequences were imported from QCYTSN/dsh-dafeiyu (Copyright (c) 2026 QCYTSN, MIT), pinned to commit 084323845ab82b68d5388d5c638bec09d8544a8a.
Their manifest pins the original video set at PC2005-cloud/dsh-pet commit 549fff2ea33c2acfb16612c76912c6137da4a758.

Sources:
- https://github.com/PC2005-cloud/dsh-pet
- https://github.com/QCYTSN/dsh-dafeiyu

AgentBerth repackages the full selected clips as transparent animated WebP with their original 24 fps timing, and ships PNG posters for static settings previews. Only imperceptible alpha noise at values 0–2 is removed from empty canvas areas; soft character edges remain semi-transparent. Selected clips, source-video digests and output digests are recorded in src/renderer/pet-assets/provenance.json. Rebuild using scripts/build-pet-assets.py and source.json.

Both full MIT license notices accompany the packaged application under resources/assets/pet. Small GIF excerpts in tests/fixtures exercise custom-GIF import and are test-only, not shipped with the application.

These are community character assets, not original AgentBerth artwork. AgentBerth is not affiliated with or endorsed by the source projects or DeepSeek. Project names and identities remain with their respective owners.
