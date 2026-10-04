# Play with the mock ERP by hand from PowerShell.
# Load it into your PowerShell window with:   . .\services\mock-erp\play.ps1
# Every command prints the HTTP request it sends (->) and what came back (<-).

$Erp = 'http://localhost:4001'
$User = 's.patel'

function Invoke-Erp {
    param([string]$Method, [string]$Path, $Body = $null, [hashtable]$Headers = @{}, [switch]$Quiet)

    if (-not $Quiet) {
        Write-Host ""
        Write-Host "-> $Method $Path" -ForegroundColor Cyan
        foreach ($k in $Headers.Keys) { Write-Host "   $($k): $($Headers[$k])" -ForegroundColor DarkCyan }
    }
    $json = $null
    if ($null -ne $Body) {
        $json = $Body | ConvertTo-Json -Depth 6 -Compress
        if (-not $Quiet) { Write-Host "   $json" -ForegroundColor DarkCyan }
    }

    $status = 0; $etag = $null; $content = $null
    try {
        $params = @{ UseBasicParsing = $true; Method = $Method; Uri = "$Erp$Path"; Headers = $Headers; TimeoutSec = 15 }
        if ($null -ne $json) { $params.Body = $json; $params.ContentType = 'application/json' }
        $r = Invoke-WebRequest @params
        $status = [int]$r.StatusCode; $etag = $r.Headers['ETag']; $content = $r.Content
    }
    catch [System.Net.WebException] {
        $resp = $_.Exception.Response
        if ($null -eq $resp) {
            Write-Host "<- NO RESPONSE: $($_.Exception.Message)" -ForegroundColor Red
            Write-Host "   (The request may or may not have been carried out. You can't tell from here.)" -ForegroundColor Red
            return $null
        }
        $status = [int]$resp.StatusCode
        $content = $_.ErrorDetails.Message
    }

    $parsed = if ($content) { $content | ConvertFrom-Json } else { $null }
    if (-not $Quiet) {
        $colour = if ($status -lt 300) { 'Green' } elseif ($status -lt 500) { 'Yellow' } else { 'Red' }
        Write-Host "<- $status" -ForegroundColor $colour
        if ($etag) { Write-Host "   ETag: $etag" -ForegroundColor $colour }
        if ($parsed -and $parsed.error) { Write-Host "   $($parsed.error.code): $($parsed.error.message)" -ForegroundColor $colour }
        elseif ($parsed) { Write-Host ($parsed | ConvertTo-Json -Depth 6) }
    }
    return $parsed
}

# ---------- setup ----------

function Reset-Erp {
    $null = Invoke-Erp POST '/sim/reset' @{ fixtures = @('base') } -Quiet
    Write-Host "ERP reset to the standard Kestrel Cement data." -ForegroundColor Green
}

# Walks a new order through the physical world until its delivery is weighed and ready for goods issue.
function New-LoadedDelivery {
    param([double]$NetT = 30)
    $so = Invoke-Erp POST '/sim/salesorders' @{
        customerId = 'C1001'; plantId = 'KC01'; orderValue = 3000; requestedDate = '2026-10-04'
        items = @(@{ itemNo = 10; materialId = 'OPC53-BAG'; quantityT = 30 })
    } -Quiet
    $d = Invoke-Erp POST '/sim/deliveries' @{
        salesOrderId = $so.salesOrderId
        items = @(@{ itemNo = 10; materialId = 'OPC53-BAG'; slocId = 'FG01'; batchId = 'B2610-0141'; plannedQtyT = 30 })
    } -Quiet
    $id = $d.deliveryId; $sh = $d.shipmentId
    $null = Invoke-Erp POST "/sim/deliveries/$id/pick" @{} -Quiet
    $s = Invoke-WebRequest -UseBasicParsing "$Erp/odata/Shipments('$sh')"
    $null = Invoke-Erp POST "/odata/Shipments('$sh')/AssignTruck" @{ truckId = 'TRK-011' } @{ 'If-Match' = $s.Headers['ETag']; 'X-User' = 'd.jones' } -Quiet
    foreach ($e in @(@{ type = 'GATE_IN' }, @{ type = 'TARE'; weightT = 14 }, @{ type = 'LOADING' }, @{ type = 'GROSS'; weightT = 14 + $NetT })) {
        $null = Invoke-Erp POST "/sim/shipments/$sh/events" $e -Quiet
    }
    Write-Host "Delivery $id (order $($so.salesOrderId), shipment $sh): truck TRK-011 loaded and weighed." -ForegroundColor Green
}

# ---------- reading ----------

function Get-Delivery {
    param([string]$Id)
    $null = Invoke-Erp GET "/odata/OutboundDeliveries('$Id')?`$select=deliveryId,status,pgiPostedAt"
}

function Get-GoodsMovements {
    param([string]$Id)
    $null = Invoke-Erp GET "/odata/OutboundDeliveries('$Id')/goodsMovements?`$select=goodsMovementId,movementType,clientReference,postedBy,postedAt"
}

# The ERP's full history for a document, including chaos the copilot never sees.
function Show-History {
    param([string]$Id)
    $r = Invoke-Erp GET "/sim/events?documentId=$Id" -Quiet
    $r.value | ForEach-Object {
        [pscustomobject]@{
            at      = ([datetime]$_.at).ToString('HH:mm:ss')
            event   = $_.eventType
            by      = $_.by
            details = (($_.details.PSObject.Properties | ForEach-Object { "$($_.Name)=$($_.Value)" }) -join '; ')
        }
    } | Format-Table -AutoSize -Wrap
}

# ---------- writing ----------

# Post goods issue. -Version is the number inside the ETag: for W/"7", pass -Version 7.
# -Reference (optional) is your label for this attempt, e.g. a proposal id like P-0007.
function Send-GoodsIssue {
    param([string]$Id, [int]$Version, [string]$Reference)
    $body = @{ postingDate = '2026-10-04' }
    if ($Reference) { $body.clientReference = $Reference }
    $null = Invoke-Erp POST "/odata/OutboundDeliveries('$Id')/PostGoodsIssue" $body @{
        'If-Match' = "W/`"$Version`""; 'X-User' = $User
    }
}

# ---------- chaos ----------

function Set-Chaos {
    param([ValidateSet('timeout', 'lock', 'outage', 'off')][string]$Kind)
    switch ($Kind) {
        'timeout' { $rules = @(@{ kind = 'timeout_after_commit'; action = 'PostGoodsIssue'; times = 1 }) }
        'lock'    { $rules = @(@{ kind = 'lock_conflict'; action = 'PostGoodsIssue'; times = 1 }) }
        'outage'  { $rules = @(@{ kind = 'outage'; startAfterRequests = 0; durationSeconds = 30 }) }
        'off'     { $rules = @() }
    }
    $null = Invoke-Erp PUT '/sim/chaos' @{ rules = $rules } -Quiet
    Write-Host "Chaos: $Kind" -ForegroundColor Magenta
}

Write-Host "Mock ERP playground loaded. Commands:" -ForegroundColor Green
Write-Host "  Reset-Erp, New-LoadedDelivery, Get-Delivery <id>, Get-GoodsMovements <id>, Show-History <id>"
Write-Host "  Send-GoodsIssue <id> -Version <n> [-Reference P-0007], Set-Chaos timeout|lock|outage|off"
