from base.spider import Spider

class Spider(Spider):
    def init(self, extend=""):
        self.extend = extend

    def homeContent(self, filter):
        return {
            "class": [{"type_id": "1", "type_name": "Fixture"}],
            "list": [{"vod_id": "fixture-1", "vod_name": "MisaTV runtime fixture"}]
        }
