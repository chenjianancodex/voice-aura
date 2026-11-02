param(
  [string]$OutPath = "test-tts.wav",
  [string]$TextPath = "test-text.txt"
)
Add-Type -AssemblyName System.Speech
$s = New-Object System.Speech.Synthesis.SpeechSynthesizer
$s.SelectVoice('Microsoft Huihui Desktop')
$s.Rate = -2
$s.SetOutputToWaveFile($OutPath)
$text = [System.IO.File]::ReadAllText($TextPath, [System.Text.Encoding]::UTF8)
$s.Speak($text)
$s.Dispose()
Write-Output ("written: " + $OutPath)
