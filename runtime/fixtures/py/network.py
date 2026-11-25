from base.spider import Spider
import requests

class Spider(Spider):
    def homeContent(self, filter):
        response = requests.get("https://example.com/", timeout=12)
        return {
            "class": [],
            "list": [{
                "vod_id": "network-py",
                "http_status": response.status_code,
                "example_domain": "Example Domain" in response.text
            }]
        }
