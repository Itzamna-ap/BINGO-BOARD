$html = Get-Content -Path "bingo.html" -Raw
$replacements = @{
    "Main-Background.jpg" = "image/jpeg"
    "Header-Background.jpg" = "image/jpeg"
    "Grid-Panel-Background.png" = "image/png"
    "Latest-Number-Panel.png" = "image/png"
    "History-Panel.png" = "image/png"
}

foreach ($file in $replacements.Keys) {
    if (Test-Path $file) {
        Write-Host "Embedding $file..."
        $fullPath = Resolve-Path $file
        $bytes = [IO.File]::ReadAllBytes($fullPath)
        $base64 = [Convert]::ToBase64String($bytes)
        $mime = $replacements[$file]
        $newUrl = "data:$mime;base64,$base64"
        # Escape special characters if necessary, but string replacement should be fine locally
        $html = $html.Replace("url('$file')", "url('$newUrl')")
    } else {
        Write-Warning "File not found: $file"
    }
}

Set-Content -Path "bingo_standalone.html" -Value $html
Write-Host "Successfully created bingo_standalone.html"
