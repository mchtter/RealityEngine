#!/usr/bin/env bash
# ==============================================================================
# Kavra 3D City Engine — Marka / İsim Değiştirme Betiği
# 
# Bu betik, geçici "Kavra" ismini nihai isimle (örneğin "City 7D", "Seven Days")
# tek bir komutla tüm projede değiştirir.
#
# Kullanım:
#   ./scripts/rename-brand.sh "YeniAd" "yeni-slug" "yeni_snake"
# Örnek:
#   ./scripts/rename-brand.sh "City 7D" "city7d" "city7d"
# ==============================================================================

set -euo pipefail

NEW_NAME="${1:?Kullanım: $0 \"Görünen Ad (Örn: City 7D)\" \"slug (Örn: city7d)\" \"snake_case (Örn: city7d)\"}"
NEW_SLUG="${2:?Slug belirtilmedi (Örn: city7d)}"
NEW_SNAKE="${3:?Snake case belirtilmedi (Örn: city7d)}"
NEW_PASCAL="$(echo "$NEW_NAME" | tr -d ' ')"

echo "=== Marka Güncellemesi Başlatılıyor ==="
echo "Görünen Ad: $NEW_NAME"
echo "Slug:       $NEW_SLUG"
echo "PascalCase: $NEW_PASCAL"
echo "SnakeCase:  $NEW_SNAKE"

# Proje dosyalarında kelime değişimleri
find . -type f \
  -not -path '*/.*' \
  -not -path '*/node_modules/*' \
  -not -path '*/dist/*' \
  -not -path '*/pkg/*' \
  -not -path '*/target/*' | while read -r file; do
    sed -i '' "s/@kavra/@$NEW_SLUG/g" "$file" 2>/dev/null || true
    sed -i '' "s/kavra-/$NEW_SLUG-/g" "$file" 2>/dev/null || true
    sed -i '' "s/kavra_/$NEW_SNAKE_/g" "$file" 2>/dev/null || true
    sed -i '' "s/KavraEngine/${NEW_PASCAL}Engine/g" "$file" 2>/dev/null || true
    sed -i '' "s/KavraViewer/${NEW_PASCAL}Viewer/g" "$file" 2>/dev/null || true
    sed -i '' "s/KavraGrid/${NEW_PASCAL}Grid/g" "$file" 2>/dev/null || true
    sed -i '' "s/initKavraGeo/init${NEW_PASCAL}Geo/g" "$file" 2>/dev/null || true
    sed -i '' "s/kavraGeoReady/${NEW_SLUG}GeoReady/g" "$file" 2>/dev/null || true
    sed -i '' "s/KAVRA/$NEW_NAME/g" "$file" 2>/dev/null || true
    sed -i '' "s/Kavra/$NEW_NAME/g" "$file" 2>/dev/null || true
done

echo "✔ Marka adı başarıyla '$NEW_NAME' olarak güncellendi!"
