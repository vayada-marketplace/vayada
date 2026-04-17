# ─── S3 bucket for docs static site ───

resource "aws_s3_bucket" "docs" {
  bucket = "vayada-docs"

  tags = {
    Name = "vayada-docs"
  }
}

resource "aws_s3_bucket_website_configuration" "docs" {
  bucket = aws_s3_bucket.docs.id

  index_document {
    suffix = "index.html"
  }

  error_document {
    key = "404.html"
  }
}

resource "aws_s3_bucket_public_access_block" "docs" {
  bucket = aws_s3_bucket.docs.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_policy" "docs" {
  bucket = aws_s3_bucket.docs.id

  depends_on = [aws_s3_bucket_public_access_block.docs]

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid       = "AllowCloudFrontOAC"
        Effect    = "Allow"
        Principal = { Service = "cloudfront.amazonaws.com" }
        Action    = "s3:GetObject"
        Resource  = "${aws_s3_bucket.docs.arn}/*"
        Condition = {
          StringEquals = {
            "AWS:SourceArn" = aws_cloudfront_distribution.docs.arn
          }
        }
      }
    ]
  })
}

# ─── ACM cert in us-east-1 (required for CloudFront) ───

provider "aws" {
  alias  = "us_east_1"
  region = "us-east-1"
}

resource "aws_acm_certificate" "docs" {
  provider          = aws.us_east_1
  domain_name       = "docs.vayada.com"
  validation_method = "DNS"

  lifecycle {
    create_before_destroy = true
  }

  tags = {
    Name = "docs-vayada-com"
  }
}

resource "aws_route53_record" "docs_cert_validation" {
  for_each = {
    for dvo in aws_acm_certificate.docs.domain_validation_options : dvo.domain_name => {
      name   = dvo.resource_record_name
      record = dvo.resource_record_value
      type   = dvo.resource_record_type
    }
  }

  allow_overwrite = true
  name            = each.value.name
  records         = [each.value.record]
  ttl             = 60
  type            = each.value.type
  zone_id         = data.aws_route53_zone.main.zone_id
}

resource "aws_acm_certificate_validation" "docs" {
  provider                = aws.us_east_1
  certificate_arn         = aws_acm_certificate.docs.arn
  validation_record_fqdns = [for record in aws_route53_record.docs_cert_validation : record.fqdn]
}

# ─── CloudFront Origin Access Control ───

resource "aws_cloudfront_origin_access_control" "docs" {
  name                              = "vayada-docs-oac"
  description                       = "OAC for vayada docs S3 bucket"
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

# ─── CloudFront distribution ───

resource "aws_cloudfront_distribution" "docs" {
  enabled             = true
  is_ipv6_enabled     = true
  default_root_object = "index.html"
  aliases             = ["docs.vayada.com"]
  price_class         = "PriceClass_100"

  origin {
    domain_name              = aws_s3_bucket.docs.bucket_regional_domain_name
    origin_id                = "S3-vayada-docs"
    origin_access_control_id = aws_cloudfront_origin_access_control.docs.id
  }

  default_cache_behavior {
    allowed_methods        = ["GET", "HEAD"]
    cached_methods         = ["GET", "HEAD"]
    target_origin_id       = "S3-vayada-docs"
    viewer_protocol_policy = "redirect-to-https"
    compress               = true

    forwarded_values {
      query_string = false
      cookies {
        forward = "none"
      }
    }

    min_ttl     = 0
    default_ttl = 3600
    max_ttl     = 86400
  }

  # SPA-style routing: serve index.html for 404s so Docusaurus handles routing
  custom_error_response {
    error_code            = 403
    response_code         = 200
    response_page_path    = "/index.html"
    error_caching_min_ttl = 10
  }

  custom_error_response {
    error_code            = 404
    response_code         = 200
    response_page_path    = "/index.html"
    error_caching_min_ttl = 10
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  viewer_certificate {
    acm_certificate_arn      = aws_acm_certificate_validation.docs.certificate_arn
    ssl_support_method       = "sni-only"
    minimum_protocol_version = "TLSv1.2_2021"
  }

  tags = {
    Name = "vayada-docs"
  }
}

# ─── DNS record ───

resource "aws_route53_record" "docs" {
  zone_id = data.aws_route53_zone.main.zone_id
  name    = "docs.vayada.com"
  type    = "A"

  alias {
    name                   = aws_cloudfront_distribution.docs.domain_name
    zone_id                = aws_cloudfront_distribution.docs.hosted_zone_id
    evaluate_target_health = false
  }
}

# ─── Outputs ───

output "docs_cloudfront_distribution_id" {
  value = aws_cloudfront_distribution.docs.id
}

output "docs_s3_bucket" {
  value = aws_s3_bucket.docs.bucket
}
