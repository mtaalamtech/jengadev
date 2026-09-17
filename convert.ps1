Add-Type -AssemblyName System.Drawing
$bmp = New-Object System.Drawing.Bitmap "dashboard/logo.png"
$icon = [System.Drawing.Icon]::FromHandle($bmp.GetHicon())
$fs = New-Object System.IO.FileStream "JengaDev.ico", OpenOrCreate
$icon.Save($fs)
$fs.Close()
$bmp.Dispose()
